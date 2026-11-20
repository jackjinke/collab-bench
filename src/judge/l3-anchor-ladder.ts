import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AnchorItem,
  AnchorPlacementVote,
  L3AnchorResult,
} from "../schema/types";
import { callJudgeCached, parseJudgeJson, type SelectedJudge } from "./panel";

interface RawAnchorPlacement {
  lower_anchor_id: string | null;
  upper_anchor_id: string | null;
  position_fraction: number; // 0.0 = at lower anchor, 1.0 = at upper anchor
  reasoning: string;
}

interface RawPairwiseVote {
  winner: "A" | "B" | "tie";
  reasoning: string;
}

const ANCHOR_SYSTEM_PROMPT = `You are a calibrated editorial & design taste judge.
You NEVER invent free-form 1-10 ratings. Instead, you are given a calibrated ladder of reference anchors with fixed human ground-truth scores (including intentionally low-scoring decoys such as flashy templates or cluttered text/badge dumps).
Your job is strictly to place the anonymized CANDIDATE between two adjacent anchors (or below the lowest / above the highest) and provide a position_fraction in [0.0, 1.0].
Return ONLY valid JSON.`;

function interpolatePlacement(
  sortedAnchors: AnchorItem[],
  parsed: RawAnchorPlacement,
): { score: number; between: [string, string] } {
  const byId = new Map(sortedAnchors.map((a) => [a.id, a]));
  const frac = Math.max(0, Math.min(1, Number(parsed.position_fraction ?? 0.5)));
  const low = parsed.lower_anchor_id ? byId.get(parsed.lower_anchor_id) : undefined;
  const high = parsed.upper_anchor_id ? byId.get(parsed.upper_anchor_id) : undefined;

  if (low && high) {
    const lo = Math.min(low.score, high.score);
    const hi = Math.max(low.score, high.score);
    return {
      score: Math.round(lo + frac * (hi - lo)),
      between: [low.id, high.id],
    };
  }
  if (!low && high) {
    // Below lowest anchor
    return {
      score: Math.max(0, Math.round(high.score * frac)),
      between: ["BOTTOM", high.id],
    };
  }
  if (low && !high) {
    // Above highest anchor
    return {
      score: Math.min(100, Math.round(low.score + frac * (100 - low.score))),
      between: [low.id, "TOP"],
    };
  }
  // Fallback midpoint if judge gave unrecognized IDs
  const mid = sortedAnchors[Math.floor(sortedAnchors.length / 2)]!;
  return { score: mid.score, between: [mid.id, mid.id] };
}

/**
 * Evaluate a candidate against a calibrated anchor ladder with BOTH normal (ascending)
 * and reversed (descending) anchor ordering to detect and average out position bias.
 */
export async function evaluateAnchorLadder(opts: {
  taskDir: string;
  rubric: string;
  modality: "text" | "vision";
  anchors: AnchorItem[];
  candidateText?: string;
  candidateImagePath?: string;
  judges: SelectedJudge[];
  cacheDir: string;
  anchorScreenshotMap?: Map<string, string>;
}): Promise<L3AnchorResult> {
  const sortedAsc = [...opts.anchors].sort((a, b) => a.score - b.score);
  const sortedDesc = [...sortedAsc].reverse();

  const votes: AnchorPlacementVote[] = [];
  const orders: Array<{ order: "normal" | "reversed"; list: AnchorItem[] }> = [
    { order: "normal", list: sortedAsc },
    { order: "reversed", list: sortedDesc },
  ];

  const tasks: Array<Promise<void>> = [];

  for (const judge of opts.judges) {
    for (const { order, list } of orders) {
      tasks.push(
        (async () => {
          const attachments: string[] = [];
          const anchorDescriptions: string[] = [];

          for (let i = 0; i < list.length; i++) {
            const a = list[i]!;
            const filePath = join(opts.taskDir, a.file);
            if (opts.modality === "vision") {
              const imgPath = opts.anchorScreenshotMap?.get(a.id) ?? filePath;
              if (existsSync(imgPath)) attachments.push(imgPath);
              anchorDescriptions.push(
                `- Anchor "${a.id}" (human calibrated score = ${a.score}/100, archetype = ${a.archetype ?? "ref"}, attached image #${attachments.length}): ${a.label} — ${a.rationale}`,
              );
            } else {
              const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "(missing)";
              anchorDescriptions.push(
                `--- Anchor "${a.id}" (human calibrated score = ${a.score}/100, archetype = ${a.archetype ?? "ref"}): ${a.label} ---\nRationale: ${a.rationale}\n${content}`,
              );
            }
          }

          let candidateSection: string;
          if (opts.modality === "vision" && opts.candidateImagePath && existsSync(opts.candidateImagePath)) {
            attachments.push(opts.candidateImagePath);
            candidateSection = `CANDIDATE is attached image #${attachments.length}.`;
          } else {
            candidateSection = `<candidate>\n${opts.candidateText ?? ""}\n</candidate>`;
          }

          const prompt = `Evaluation Rubric:
${opts.rubric}

Calibrated Reference Anchors (presented in ${order} score order):
${anchorDescriptions.join("\n\n")}

Candidate to Place:
${candidateSection}

Place CANDIDATE along the calibrated anchor ladder. Specify the adjacent lower_anchor_id (or null if below the lowest-scoring anchor) and upper_anchor_id (or null if above the highest-scoring anchor), plus position_fraction in [0.0, 1.0].

Return ONLY JSON:
{
  "lower_anchor_id": "<id or null>",
  "upper_anchor_id": "<id or null>",
  "position_fraction": 0.5,
  "reasoning": "<concise comparison against the two bracketing anchors>"
}`;

          const resp = await callJudgeCached({
            judge,
            systemPrompt: ANCHOR_SYSTEM_PROMPT,
            prompt,
            attachments: attachments.length > 0 ? attachments : undefined,
            cacheDir: opts.cacheDir,
          });
          const parsed = parseJudgeJson<RawAnchorPlacement>(resp.text);
          const interp = interpolatePlacement(sortedAsc, parsed);

          votes.push({
            judge_model: judge.model,
            order,
            placed_score: interp.score,
            between_anchors: interp.between,
            reasoning: String(parsed.reasoning ?? ""),
            cached: resp.cached,
          });
        })(),
      );
    }
  }

  await Promise.all(tasks);

  // Compute mean score and position-swap delta
  const normalScores = votes.filter((v) => v.order === "normal").map((v) => v.placed_score);
  const reversedScores = votes.filter((v) => v.order === "reversed").map((v) => v.placed_score);
  const meanNormal =
    normalScores.length > 0 ? normalScores.reduce((a, b) => a + b, 0) / normalScores.length : 0;
  const meanReversed =
    reversedScores.length > 0 ? reversedScores.reduce((a, b) => a + b, 0) / reversedScores.length : 0;
  const allScores = votes.map((v) => v.placed_score);
  const overall = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0;

  return {
    score: overall,
    position_swap_delta: Math.round(Math.abs(meanNormal - meanReversed)),
    votes,
  };
}

/**
 * Position-swapped pairwise comparison between two anonymized outputs (A vs B and B vs A).
 * Returns +1 if item1 wins consistently, -1 if item2 wins consistently, 0 on tie/flip.
 */
export async function comparePairPositionSwapped(opts: {
  rubric: string;
  content1: string;
  content2: string;
  judge: SelectedJudge;
  cacheDir: string;
}): Promise<{ outcome: -1 | 0 | 1; consistent: boolean; rawVotes: RawPairwiseVote[] }> {
  const sys =
    "You compare two anonymized responses A and B strictly against the rubric. Never favor length for its own sake. Output ONLY JSON: {\"winner\":\"A\"|\"B\"|\"tie\",\"reasoning\":\"...\"}.";

  const makePrompt = (a: string, b: string) =>
    `Rubric:\n${opts.rubric}\n\n<response_A>\n${a}\n</response_A>\n\n<response_B>\n${b}\n</response_B>\n\nReturn ONLY JSON.`;

  const [r1, r2] = await Promise.all([
    callJudgeCached({ judge: opts.judge, systemPrompt: sys, prompt: makePrompt(opts.content1, opts.content2), cacheDir: opts.cacheDir }),
    callJudgeCached({ judge: opts.judge, systemPrompt: sys, prompt: makePrompt(opts.content2, opts.content1), cacheDir: opts.cacheDir }),
  ]);

  const v1 = parseJudgeJson<RawPairwiseVote>(r1.text);
  const v2 = parseJudgeJson<RawPairwiseVote>(r2.text);

  // Normalize v2 back to (item1 vs item2) coordinates
  const norm1 = v1.winner === "A" ? 1 : v1.winner === "B" ? -1 : 0;
  const norm2 = v2.winner === "A" ? -1 : v2.winner === "B" ? 1 : 0;
  const consistent = norm1 === norm2;
  const sum = norm1 + norm2;
  const outcome: -1 | 0 | 1 = sum > 0 ? 1 : sum < 0 ? -1 : 0;

  return { outcome, consistent, rawVotes: [v1, v2] };
}

export interface PairwiseMatch {
  playerA: string;
  playerB: string;
  /** 1.0 = A won, 0.5 = tie, 0.0 = B won */
  scoreA: number;
}

/**
 * Pure iterative Minorization-Maximization (MM) Bradley-Terry MLE solver.
 * Converts pairwise win/tie comparisons into calibrated 0..100 ratings.
 */
export function fitBradleyTerry(matches: PairwiseMatch[], maxIter = 200): Record<string, number> {
  const players = Array.from(new Set(matches.flatMap((m) => [m.playerA, m.playerB]))).sort();
  if (players.length === 0) return {};
  if (players.length === 1) return { [players[0]!]: 50 };

  const strengths = new Map<string, number>(players.map((p) => [p, 1.0]));
  const wins = new Map<string, number>(players.map((p) => [p, 0]));
  const pairCounts = new Map<string, number>();

  for (const m of matches) {
    wins.set(m.playerA, (wins.get(m.playerA) ?? 0) + m.scoreA);
    wins.set(m.playerB, (wins.get(m.playerB) ?? 0) + (1 - m.scoreA));
    const k1 = `${m.playerA}\0${m.playerB}`;
    const k2 = `${m.playerB}\0${m.playerA}`;
    pairCounts.set(k1, (pairCounts.get(k1) ?? 0) + 1);
    pairCounts.set(k2, (pairCounts.get(k2) ?? 0) + 1);
  }

  // Tiny Laplace smoothing prevents divergence on undefeated / 0-win models
  const eps = 0.05;
  for (let iter = 0; iter < maxIter; iter++) {
    let maxDelta = 0;
    const next = new Map<string, number>();
    for (const i of players) {
      let denom = 0;
      const pi = strengths.get(i)!;
      for (const j of players) {
        if (i === j) continue;
        const nij = (pairCounts.get(`${i}\0${j}`) ?? 0) + eps;
        denom += nij / (pi + strengths.get(j)!);
      }
      const wi = (wins.get(i) ?? 0) + eps * (players.length - 1) * 0.5;
      const updated = denom > 0 ? wi / denom : 1;
      next.set(i, updated);
    }
    // Geometric mean normalization to 1.0
    const logMean =
      Array.from(next.values()).reduce((acc, v) => acc + Math.log(Math.max(v, 1e-9)), 0) / players.length;
    const scale = Math.exp(logMean);
    for (const i of players) {
      const normalized = next.get(i)! / scale;
      maxDelta = Math.max(maxDelta, Math.abs(normalized - strengths.get(i)!));
      strengths.set(i, normalized);
    }
    if (maxDelta < 1e-7) break;
  }

  // Map log-strength via logistic curve centered at 50 (range roughly 5..95)
  const out: Record<string, number> = {};
  for (const p of players) {
    const logS = Math.log(Math.max(strengths.get(p)!, 1e-9));
    out[p] = Math.round(100 / (1 + Math.exp(-logS)));
  }
  return out;
}
