/**
 * Deterministic cultivation progression.
 *
 * The model writes the story, but it does **not** get to invent the cultivation
 * level. Long playtests showed that a prompt-only rule ("gain 1–3 layers per
 * turn") is ignored for many turns, especially when the scene is social or
 * combat-heavy. So the server parses the previous state from the replayed
 * history, computes the next level, tells the model the exact level to write,
 * and finally normalizes the status line if the model still drifts.
 *
 * The mapping is fixed by design:
 *
 * | Layer | Stage |
 * | --- | --- |
 * | 1–3 | 前期 (early) |
 * | 4–6 | 中期 (middle) |
 * | 7–9 | 后期 (late) |
 * | 10 | 大圆满 (perfection) |
 *
 * Advancement is +2 layers per turn, capped at 10, so a turn never skips a
 * stage and never reaches layer 11. From 10 the next turn enters the next
 * realm at 前期 1. This is faster than the model's usual +1 while staying
 * within the "at most 3 sub-levels per turn" rule.
 */

export const REALMS = ['炼气', '筑基', '结丹', '元婴', '化神', '炼虚', '合体', '大乘', '渡劫'] as const;
export type Realm = (typeof REALMS)[number];
export type CultivationRealm = Realm | '凡人';

export interface CultivationLevel {
  realm: CultivationRealm;
  /** 1–10; 0 for 凡人. */
  layer: number;
}

/** Layers advanced per turn. Deliberately 2: visible progress, no stage skip. */
export const LAYERS_PER_TURN = 2;

/** Stage name for a layer. */
export const stageOf = (layer: number): string => {
  if (layer >= 10) return '大圆满';
  if (layer >= 7) return '后期';
  if (layer >= 4) return '中期';
  return '前期';
};

/** Canonical display form, e.g. `炼气期中期5层`. */
export const formatLevel = (level: CultivationLevel): string =>
  level.realm === '凡人' ? '凡人' : `${level.realm}期${stageOf(level.layer)}${level.layer}层`;

const REALM_ALIASES: Record<string, Realm> = {
  炼气: '炼气',
  练气: '炼气',
  筑基: '筑基',
  结丹: '结丹',
  元婴: '元婴',
  化神: '化神',
  炼虚: '炼虚',
  合体: '合体',
  大乘: '大乘',
  渡劫: '渡劫'
};

const LEVEL_RE = /^(炼气|练气|筑基|结丹|元婴|化神|炼虚|合体|大乘|渡劫)(?:期)?(前期|中期|后期|大圆满)?(\d+)?层?/;

/**
 * Parse the last `🔥` status line from an assistant message.
 *
 * Accepts both the model's natural variants (`练气期1层`, `练气期中期5层`) and
 * the canonical `炼气期前期1层`. Returns null when the line is missing or
 * unreadable; the caller then starts from 凡人.
 */
export const parseLevel = (text: string): CultivationLevel | null => {
  const line = text
    .split('\n')
    .reverse()
    .find((candidate) => candidate.includes('🔥'));
  if (line === undefined) return null;

  const segments = line.split('|');
  const raw = (segments[segments.length - 1] ?? '').replace(/\s/g, '');
  if (raw === '' || raw.includes('凡人')) return { realm: '凡人', layer: 0 };

  const match = LEVEL_RE.exec(raw);
  if (match === null) return null;

  const realm = REALM_ALIASES[match[1] ?? ''];
  if (realm === undefined) return null;

  if (match[3] !== undefined) {
    const layer = Number(match[3]);
    if (!Number.isInteger(layer) || layer < 1 || layer > 10) return null;
    return { realm, layer };
  }

  // No explicit layer: infer it from the stage word.
  const stage = match[2];
  const layer = stage === '大圆满' ? 10 : stage === '后期' ? 7 : stage === '中期' ? 4 : 1;
  return { realm, layer };
};

/**
 * Compute the level this turn must end on.
 *
 * - 凡人 → next realm 前期 1
 * - layer 1–9 → +2 layers, capped at 10 (大圆满)
 * - layer 10 → next realm 前期 1
 * - last realm at 10 → stay there (the game ends at the tribulation)
 */
export const nextLevel = (current: CultivationLevel | null): CultivationLevel => {
  if (current === null || current.realm === '凡人') return { realm: '炼气', layer: 1 };
  if (current.layer >= 10) {
    const index = REALMS.indexOf(current.realm as Realm);
    if (index < 0 || index >= REALMS.length - 1) return { realm: current.realm, layer: 10 };
    return { realm: REALMS[index + 1]!, layer: 1 };
  }
  return { realm: current.realm, layer: Math.min(10, current.layer + LAYERS_PER_TURN) };
};

/**
 * Server-side settlement line appended to the system message. The model keeps
 * writing the prose; this line only fixes the level it must display.
 */
export const levelInstruction = (previous: CultivationLevel | null, next: CultivationLevel): string => {
  const previousLabel = previous === null ? '未知' : formatLevel(previous);
  return `\n【服务端结算】上轮：${previousLabel}；本轮「🔥 当前状态」末尾必须为「${formatLevel(next)}」，不得改成其他层级。`;
};

/**
 * Normalize the status line after generation.
 *
 * The system instruction normally suffices, but a long persona prompt can still
 * win. Rewriting only the last `|` segment keeps age/lifespan/name intact while
 * guaranteeing that the next turn parses the intended level.
 */
export const enforceLevel = (text: string, expected: CultivationLevel): string => {
  const wanted = formatLevel(expected);
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || !line.includes('🔥')) continue;
    const segments = line.split('|');
    segments[segments.length - 1] = ` ${wanted}`;
    lines[index] = segments.join('|');
    return lines.join('\n');
  }
  // The model omitted the status line entirely: add a minimal authoritative one
  // so the next turn can still parse the state.
  return `🔥 厉飞雨 | 未知 | 未知 | ${wanted}\n${text}`;
};

/**
 * Remove concrete layer numbers from the prose and options, and keep the realm
 * name it mentions consistent with the settled level.
 *
 * The model keeps writing "突破至炼气期中期6层" even when the server has settled
 * on 炼气期后期7层 — and, worse, it kept writing "突破至炼气期" every single turn
 * long after the player had left 炼气 behind. The status line is authoritative,
 * so the prose is normalized against it:
 *
 * - a breakthrough claim in the same realm becomes `修为精进` (nothing was
 *   broken through this turn);
 * - a breakthrough claim that really crossed a realm becomes
 *   `突破至{settled realm}期`;
 * - any other level mention (`炼气期中期6层`) collapses to the settled realm.
 *
 * No layer number ever survives outside `🔥`: it would contradict the status
 * line, and the frontend parses only the status line.
 */
const BREAKTHROUGH_RE =
  /(成功)?(突破至|突破到|突破|晋级为|晋级|进阶至|进阶|晋升至|晋升|升至|踏入|迈入|修至|直达|达至)(炼气|练气|筑基|结丹|元婴|化神|炼虚|合体|大乘|渡劫)(?:期)?(?:前期|中期|后期|大圆满)?\s*\d*\s*层?/g;

const LEVEL_MENTION_RE =
  /(炼气|练气|筑基|结丹|元婴|化神|炼虚|合体|大乘|渡劫)(?:期)?(?:前期|中期|后期|大圆满)?\s*\d+\s*层/g;

/** Lines whose subject is the player: the result line and the option lines. */
const isPlayerLine = (line: string): boolean => line.includes('✅') || /^\s*[A-C][.、]/.test(line);

export const stripProseLayers = (
  text: string,
  settled?: CultivationLevel | null,
  previous?: CultivationLevel | null
): string => {
  const settledRealm = settled !== null && settled !== undefined && settled.realm !== '凡人' ? settled.realm : null;
  const target = settledRealm === null ? null : `${settledRealm}期`;
  const crossed = settledRealm !== null && previous !== null && previous !== undefined && previous.realm !== settledRealm;

  return text
    .split('\n')
    .map((line) => {
      if (line.includes('🔥')) return line; // the status line is authoritative

      // Only the player's own lines are realigned to the settled realm. An
      // event line may talk about 韩立 breaking through on his own schedule, so
      // there the realm is kept and merely loses its layer number.
      if (!isPlayerLine(line)) {
        return line
          .replace(LEVEL_MENTION_RE, '$1期')
          .replace(/(?:前期|中期|后期|大圆满)\s*\d+\s*层/g, '该境界');
      }

      let out = line.replace(BREAKTHROUGH_RE, (match, success: string | undefined, verb: string) => {
        if (target === null) return match; // unknown settled level: leave it alone
        if (!crossed) return '修为精进';
        return `${success ?? ''}${verb}${target}`;
      });
      out = out.replace(LEVEL_MENTION_RE, () => target ?? '该境界');
      out = out.replace(/(?:前期|中期|后期|大圆满)\s*\d+\s*层/g, '该境界');
      return out;
    })
    .join('\n');
};
