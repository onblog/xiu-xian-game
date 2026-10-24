/**
 * The world bible — and the deterministic director that enforces it.
 *
 * ## Why this file exists
 *
 * The original persona prompt carried the whole world in two run-on sentences
 * (see rule 7 and 8 of `GAME_SYSTEM_PROMPT`). In play that produced two
 * failures: the model invented geography, and a run had no finish line — the
 * player could drift through the same handful of places for a hundred turns.
 *
 * So the world is now **data**, and the prompt text, the per-turn director
 * instruction and `scripts/verify.mts` all read the same tables:
 *
 * - `REALM_REGIONS` — who may be where. A realm can only reach the regions in
 *   its own row, which is what makes 灵界 unreachable before 化神.
 * - `ARC_BY_REALM` — the chapter the current realm belongs to.
 * - `MANDATORY_CAST` — characters that must appear before the run ends.
 * - `GAME_MAX_TURNS` — the hard ceiling (100). The natural finish is ≈55 turns;
 *   this is the safety net, not the intended length.
 *
 * The per-turn `directorInstruction()` is what actually holds the line: the
 * model is told the exact map, chapter and cast for this turn, the same way
 * `progression.ts` tells it the exact cultivation level.
 */

import { REALMS, formatLevel, type CultivationLevel, type CultivationRealm } from './progression.ts';

/**
 * Hard ceiling on one run, in turns.
 *
 * The intended length is ≈55 turns: +2 layers per turn over 9 realms. This cap
 * only exists so a model that stalls for a dozen turns still cannot run forever.
 */
export const GAME_MAX_TURNS = 100;

/** One reachable region for a cultivation realm. */
export interface Region {
  /** Top-level geography, e.g. `人界·天南·越国`. */
  area: string;
  /** Named places the player may actually travel to at this realm. */
  places: string[];
  /** The gate that unlocks this row, in one line. */
  gate: string;
}

/**
 * Realm → reachable regions. This is a **hard** gate, not a suggestion.
 *
 * 灵界 only appears from 化神 onward, and 化神 forces the crossing: in the
 * original novel a 化神 cultivator cannot stay in the human realm, so the story
 * must move the player to 天渊城 rather than let them linger.
 */
export const REALM_REGIONS: Record<CultivationRealm, Region> = {
  凡人: {
    area: '人界·天南·越国',
    places: ['七玄门', '彩霞山', '镜州'],
    gate: '凡俗江湖，无修仙资源；七玄门是武侠门派，只有墨大夫身怀《长春功》'
  },
  炼气: {
    area: '人界·天南·越国',
    places: ['七玄门', '黄枫谷', '掩月宗', '灵兽山', '升仙大会', '血色禁地'],
    gate: '升仙大会后拜入越国七派；活动范围不出天南'
  },
  筑基: {
    area: '人界·天南（越国、溪国）与乱星海边缘',
    places: ['黄枫谷', '落云宗', '古剑门', '百巧院', '魁星岛'],
    gate: '筑基后可远行；溪国三派与乱星海边缘开放，魔道入侵天南是本章主线'
  },
  结丹: {
    area: '人界·乱星海与大晋',
    places: ['星宫', '逆星盟', '魁星岛', '北冥岛', '岳阳宫'],
    gate: '结丹后可横渡乱星海；大晋只能到岳阳宫一带'
  },
  元婴: {
    area: '人界·大晋与天南',
    places: ['昆吾山', '阴罗宗', '天魔宗', '极西之地', '阴冥之地', '天南'],
    gate: '元婴后进入大晋腹地；昆吾山、阴冥之地只对元婴开放'
  },
  化神: {
    area: '人界收尾 → 灵界·风元大陆（天渊城）',
    places: ['大晋', '天南', '天渊城', '风元大陆'],
    gate: '人界最后一境。化神中期起必须动身，经空间裂缝进入灵界天渊城；这是进入灵界的唯一途径'
  },
  炼虚: {
    area: '灵界·风元大陆',
    places: ['天渊城', '雾海宗', '地渊', '镇海宫'],
    gate: '炼虚后可在风元大陆自由行走，地渊只对炼虚以上开放'
  },
  合体: {
    area: '灵界·风元大陆、雷鸣大陆、血天大陆、紫薇海',
    places: ['风元大陆', '雷鸣大陆', '血天大陆', '紫薇海', '天渊城'],
    gate: '合体后可跨大陆远行；魔界之战是本章主线'
  },
  大乘: {
    area: '灵界全境',
    places: ['风元大陆', '雷鸣大陆', '血天大陆', '紫薇海', '蛮荒界域'],
    gate: '大乘后遍行灵界，开始筹备渡劫飞升'
  },
  渡劫: {
    area: '灵界·飞升台（劫云之下）→ 仙界',
    places: ['飞升台', '天劫劫云'],
    gate: '渡劫期只在飞升台，渡劫成功即飞升仙界，全剧终'
  }
};

/** The chapter a realm belongs to. Keeps pacing on the original storyline. */
export const ARC_BY_REALM: Record<CultivationRealm, { chapter: string; goal: string }> = {
  凡人: { chapter: '第一章 七玄门风云', goal: '墨大夫夺舍阴谋，厉飞雨与韩立结为生死之交' },
  炼气: { chapter: '第二章 初踏修仙路', goal: '升仙大会拜入黄枫谷，血色禁地初遇南宫婉' },
  筑基: { chapter: '第三章 魔道入侵天南', goal: '魔道六宗入侵，天南大乱，被迫远走乱星海' },
  结丹: { chapter: '第四章 风起海外', goal: '乱星海立足：星宫与逆星盟之争' },
  元婴: { chapter: '第五章 名震一方', goal: '昆吾山通天灵宝现世，纵横人界' },
  化神: { chapter: '第六章 初入灵界', goal: '人界已容不下化神之身，必须入灵界天渊城' },
  炼虚: { chapter: '第七章 灵界百族', goal: '风元大陆立足，卷入灵界百族纷争' },
  合体: { chapter: '第八章 魔界之战', goal: '魔界入侵灵界，随天渊卫血战' },
  大乘: { chapter: '第九章 真仙降世', goal: '真仙降世搅动灵界，大乘修士应劫' },
  渡劫: { chapter: '第十章 渡劫飞升', goal: '九重天劫加身，飞升仙界，全剧终' }
};

/** A character the run is not allowed to skip. */
export interface CastMember {
  /** Canonical name, used for the roll-call. */
  name: string;
  /** Alternative spellings the model may use in prose. */
  aliases: string[];
  /** Must have appeared by the end of this realm at the latest. */
  deadline: CultivationRealm;
  /** Where the first appearance belongs. */
  home: string;
  /** One-line identity the model must respect. */
  role: string;
}

/**
 * The mandatory cast, with a deadline each.
 *
 * `deadline` is the realm by whose end the character must have appeared. The
 * director re-injects every character whose deadline has passed but whose name
 * never showed up in the replayed history — that is what stops a run from being
 * two people in an empty cave forever.
 */
export const MANDATORY_CAST: CastMember[] = [
  { name: '墨大夫', aliases: ['墨居仁'], deadline: '炼气', home: '七玄门', role: '供奉，暗中修《长春功》，图谋夺舍厉飞雨' },
  { name: '张铁', aliases: ['曲魂'], deadline: '炼气', home: '七玄门', role: '厉飞雨同门好友，憨直仗义' },
  { name: '南宫婉', aliases: [], deadline: '炼气', home: '掩月宗', role: '女修，血色禁地初遇，厉飞雨唯一道侣' },
  { name: '李化元', aliases: [], deadline: '炼气', home: '黄枫谷', role: '师叔，护短的长辈' },
  { name: '陈巧倩', aliases: [], deadline: '炼气', home: '黄枫谷', role: '同门师姐，性情爽利' },
  { name: '董萱儿', aliases: [], deadline: '筑基', home: '越国', role: '修士，暗恋韩立，心思细腻' },
  { name: '紫灵仙子', aliases: ['汪凝'], deadline: '结丹', home: '乱星海', role: '妙音门门主，第一美人，与厉飞雨亦敌亦友' },
  { name: '元瑶', aliases: [], deadline: '结丹', home: '乱星海', role: '女修，与韩立、厉飞雨同行寻宝' },
  { name: '王蝉', aliases: [], deadline: '结丹', home: '魔道', role: '结丹修士，阴狠，数次设伏' },
  { name: '玄骨上人', aliases: ['萧诧'], deadline: '元婴', home: '大晋', role: '元婴老怪，暗藏杀机' },
  { name: '银月', aliases: ['雪玲'], deadline: '化神', home: '灵界', role: '银月狼族化形，二人在灵界的引路人' },
  { name: '梅凝', aliases: [], deadline: '炼虚', home: '灵界', role: '天渊城女修，同门' },
  { name: '石穿空', aliases: [], deadline: '炼虚', home: '灵界', role: '天渊卫悍将，最重要的战友' },
  { name: '珑梦', aliases: [], deadline: '合体', home: '灵界', role: '合体修士，立场难测' }
];

/** Han Li never has a deadline: he is in every chapter. */
export const ALWAYS_PRESENT = '韩立';

const realmIndex = (realm: CultivationRealm): number =>
  realm === '凡人' ? -1 : REALMS.indexOf(realm as (typeof REALMS)[number]);

/** Where the player may be this turn. Falls back to 凡人 for an unknown state. */
export const regionFor = (level: CultivationLevel | null): Region =>
  REALM_REGIONS[level === null ? '凡人' : level.realm];

/** The chapter this realm belongs to. */
export const arcFor = (level: CultivationLevel | null): { chapter: string; goal: string } =>
  ARC_BY_REALM[level === null ? '凡人' : level.realm];

/**
 * Characters who must be written into this turn.
 *
 * A member is summoned from their deadline realm until one realm later, and
 * only while their name is absent from the replay window. The one-realm slack
 * recovers a character the model skipped entirely; the window check stops a
 * character who already appeared from being summoned every turn.
 */
export const overdueCast = (historyText: string, level: CultivationLevel | null): CastMember[] => {
  const current = realmIndex(level === null ? '凡人' : level.realm);
  return MANDATORY_CAST.filter((member) => {
    const gap = current - realmIndex(member.deadline);
    if (gap < 0 || gap > 1) return false;
    const names = [member.name, ...member.aliases];
    return !names.some((name) => historyText.includes(name));
  });
};

/** Whether this turn must end the story. */
export const isFinaleTurn = (previous: CultivationLevel | null, turnNumber: number): boolean => {
  if (turnNumber >= GAME_MAX_TURNS) return true;
  return previous !== null && previous.realm === '渡劫' && previous.layer >= 10;
};

/**
 * The prompt block the server appends every turn.
 *
 * Three things, in one block to keep the token cost down: the map lock, the
 * chapter, and (only when someone is overdue) the cast roll-call.
 */
export const directorInstruction = (
  level: CultivationLevel,
  historyText: string,
  turnNumber: number,
  finale: boolean
): string => {
  const region = regionFor(level);
  const arc = arcFor(level);
  const overdue = overdueCast(historyText, level);
  const lines = [
    '',
    '【服务端导演指令 — 本轮必须遵守】',
    `· 轮次：第 ${turnNumber} / ${GAME_MAX_TURNS} 轮（一轮约 1~10 年，不得超过 10 年）。`,
    `· 当前境界：${formatLevel(level)}；主线章节：${arc.chapter}（${arc.goal}）。`,
    `· 地图锁：本轮只能发生在「${region.area}」，可用地点仅限 ${region.places.join('、')}。${region.gate}。`,
    '· 禁止越界：不得出现本境界之外的地图与势力；化神期之前严禁亲身抵达灵界（可作传闻提及，不得前往）。',
    `· 人物：${ALWAYS_PRESENT}始终在场。`
  ];
  if (overdue.length > 0) {
    lines.push(
      `· 必须登场（本轮直接写成出场并有台词，不得只提名字）：${overdue
        .map((member) => `${member.name}（${member.home}，${member.role}）`)
        .join('；')}。`
    );
  }
  if (finale) {
    lines.push(
      '· 【终局】这是全剧最后一轮：写渡劫成功并飞升仙界，结尾必须是「✨ 结局：厉飞雨…飞升仙界，全剧终！」。',
      '· 【终局】本轮严禁输出「📌 请选择：」与 A./B./C. 选项，故事到此结束。'
    );
  }
  return lines.join('\n');
};

/** Appended once, in the system prompt, so the bible is never re-derived. */
export const GAME_WORLD_PROMPT = `
# 世界观硬设定（服务端锁定，与原著一致，不得改写、不得新增）
## 一、境界 · 寿元（九境，每境十层；前期1-3、中期4-6、后期7-9、大圆满10）
凡人：寿元 80~100 年，无灵力。
炼气期：寿元 100~120 年，可施展简单法术。
筑基期：寿元 200~250 年，辟谷、可长时间御剑飞行。
结丹期：寿元 500~600 年，可炼本命法宝，无需法器即可飞行。
元婴期：寿元 1000~1200 年，元婴可离体，肉身毁可夺舍。
化神期：寿元 2000~2500 年，可调动天地灵气，但在人界出手会消耗寿元。
炼虚期：寿元约一万三千年，每 3000 年一次大天劫。
合体期：寿元四五万年，可扛过 10 次大天劫。
大乘期：寿元十万年以上，完全脱离肉身限制。
渡劫期：九重天劫加身，成则飞升仙界。

## 二、地图与境界准入（硬门禁，境界不够就绝不许出现）
${REALMS.map((realm) => {
  const region = REALM_REGIONS[realm];
  return `- ${realm}期：${region.area}｜可去：${region.places.join('、')}｜${region.gate}`;
}).join('\n')}
硬规则：
1. 只能在「当前境界」那一行的地点活动；不得提前进入更高境界的区域。
2. 「灵界」只在化神期及以后出现。元婴期及以下严禁亲身抵达灵界、天渊城、风元大陆。
3. 化神期必须去灵界：化神中期起动身，最迟化神期大圆满前已在天渊城；不得以任何理由留在人界。
4. 突破渡劫期后只能留在飞升台，渡劫成功即刻飞升仙界，不得返回任何下界地图。
5. 大境界之间不得跨境界瞬移：进入灵界靠空间裂缝/传送阵，跨大陆靠飞行与传送阵，必须写出过程。

## 三、主线章节（按境界推进，禁止跳章、禁止另起主线）
${(['凡人', ...REALMS] as CultivationRealm[])
  .map((realm) => `- ${realm === '凡人' ? '凡人期' : `${realm}期`}：${ARC_BY_REALM[realm].chapter} —— ${ARC_BY_REALM[realm].goal}`)
  .join('\n')}

## 四、人物（必须出场，缺一即失败）
主角：厉飞雨（玩家夺舍之身，男性）、${ALWAYS_PRESENT}（同门→挚友→盟友，全程在场，绝不与厉飞雨有情感线）。
必现配角（按登场顺序）：
${MANDATORY_CAST.map((member) => `- ${member.name}（${member.home}，${member.role}）`).join('\n')}
硬规则：
1. 上列人物必须全部登场，最迟在该人物对应的境界内出场；南宫婉是厉飞雨唯一道侣。
2. 不得生造原著之外的重要人物、宗门或法宝；不得给韩立安排道侣。
3. 配角要有台词和作用，不能只出现在旁白里。

## 五、结局与轮次
1. 正常结局：渡劫成功，飞升仙界，输出「✨ 结局：厉飞雨…飞升仙界，全剧终！」。
2. 寿元耗尽：输出「💀 结局：厉飞雨 | XX岁 | 寿元耗尽，道途终结」。
3. 硬上限 ${GAME_MAX_TURNS} 轮：第 ${GAME_MAX_TURNS} 轮无论进度如何都必须飞升收尾；正常一局约 55 轮即可飞升。
4. 结局轮不输出 📌 与 A./B./C.。
`;
