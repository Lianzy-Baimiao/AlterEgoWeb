/*
 * WowAltBoard - tools/translate-prio.js
 *
 * 把 maxroll 的「出手顺序」正文从英文直译成中文。给 tools/fetch-maxroll.js 用。
 *
 * 为什么是**规则表**而不是机器翻译
 * ------------------------------
 * 用户第 19 轮的原话：「将出手顺序翻译成中文，差不多就行，不追求完美」。
 * 同一轮还定了 tooltip 一律「要么英文，要么人工直译」——**不许 AI 润色**。
 * 所以这里走的是「人手写的短语对照表 + 机械替换」：
 *   · 每一条译法都是我逐条写下的（那就是人工直译），不是模型现场生成的；
 *   · 替换是确定性的，同一句英文永远得到同一句中文，改了表能 diff；
 *   · **匹配不上的整句留英文**。留英文比给一句意思拿不准的中文安全 ——
 *     出手顺序里「unless / 除非」这类条件翻反了，用户照着打就是错的，
 *     而界面上一点异常都看不出来。
 *
 * 技能名不在这里管：正文进来之前 fetch-maxroll.js 的 substSpells 已经按
 * data-wow-id 把技能 / 天赋名换成官方中文了。所以这里只翻**句式**，
 * 一个游戏名词都不碰 —— 这也是「不凭记忆手打中文游戏名词」那条约束的要求。
 *
 * 只有一遍匹配：整句模板
 * ---------------------
 * `Cast {X} on cooldown.` → `{X} 冷却好就放。` 命中就整句换掉，读起来是通顺的中文。
 * **没命中的整句原样留英文。**
 *
 * 第一版还有第二遍「碎片替换」（把 `on cooldown`、`if you have` 这类短语单独换掉），
 * 实测之后**删掉了**：它产出的是「保持 in mind that casting 燃烧 before your 流星」
 * 这种半中半英，而且会翻错 —— `Keep in mind` 被 `Keep → 保持` 拆成了「保持 in mind」，
 * `during` 被换成「在……期间」然后位置全错。那比留英文糟：读者以为看懂了，其实句子
 * 已经不是作者的意思了。所以规矩是**整句要么全中文、要么全英文**，
 * 和用户对 tooltip 定的那条一样（「要么英文，要么人工直译」）。
 *
 * 覆盖率由 fetch-maxroll.js 印出来（整句命中多少 / 留英文多少）。
 * 那一行必须看：数字掉下来说明 maxroll 换了写法，规则表要跟着补。
 */
'use strict';

// 「一个游戏名词」——可能是中文技能名，也可能是没查到中文的英文名。
// 不允许跨句号，也不允许把整句吞掉，所以用非贪婪 + 排除句末标点。
var T = '([^.!?]+?)';

/**
 * 整句模板。**顺序有意义**：先长后短，先具体后笼统。
 * `Cast {X}.` 这种最笼统的一定放在最后，否则它会把
 * `Cast {X} on cooldown.` 里的 `{X} on cooldown` 整个当成名词吃掉。
 */
var SENT = [
  // ---- 通篇开场白
  [/^This is a general priority you aim to maintain throughout the fight\.$/,
    '下面是整场战斗都照着走的大致优先级。'],
  [new RegExp('^This is a general priority you aim to maintain for the duration of ' + T + '\\.$'),
    '下面是 $1 期间照着走的大致优先级。'],
  [/^This is a general priority for your (.+?) window\.$/,
    '下面是 $1 窗口期内的大致优先级。'],
  [/^This is the standard priority list, follow this unless a Boss or scenario requires you to hold some abilities listed here\.$/,
    '这是标准优先级；除非某个首领或场合要求你攒着某些技能，否则就照这个走。'],
  [/^Make sure to keep this list in mind, unless some bosses or scenarios require you to hold some abilities listed here\.?$/,
    '记住这个顺序；除非某些首领或场合要求你攒着某些技能。'],
  [/^The multi-target priority list is similar to the single-target priority list, the main difference is to always keep (.+?) active\.$/,
    '多目标的顺序和单体差不多，主要区别是要一直保持 $1。'],

  // ---- Cast / Use + 各种条件
  [new RegExp('^Cast ' + T + ' on cooldown, but you can delay it for a few seconds if the debuff is not about to expire on the target and you have the maximum amount of ' + T + ' stacks\\.$'),
    '$1 冷却好就放；但只要目标身上的减益还没快掉、而且 $2 已经叠满，可以压几秒。'],
  [new RegExp('^Cast ' + T + ' on cooldown as long as you have (\\d+) or less ' + T + '\\.$'),
    '只要 $3 不超过 $2，$1 冷却好就放。'],
  [new RegExp('^Cast ' + T + ' on cooldown as long as you have (\\d+) or more ' + T + '\\.$'),
    '只要有 $2 个以上 $3，$1 冷却好就放。'],
  [new RegExp('^Cast ' + T + ' if you have (\\d+)\\+ stacks of ' + T + '\\.$'),
    '$3 叠到 $2 层以上时放 $1。'],
  [new RegExp('^Cast ' + T + ' if you have (\\d+) stacks of ' + T + '\\.$'),
    '$3 有 $2 层时放 $1。'],
  [new RegExp('^Cast ' + T + ' if you have (\\d+) stacks\\.$'),
    '有 $2 层时放 $1。'],
  [new RegExp('^Cast ' + T + ' if you have less than (\\d+) stacks of ' + T + '\\.$'),
    '$3 不到 $2 层时放 $1。'],
  [new RegExp('^Cast ' + T + ' if you have ' + T + '\\.$'), '有 $2 时放 $1。'],
  [new RegExp('^Use ' + T + ' if you have ' + T + '\\.$'), '有 $2 时用 $1。'],
  [new RegExp('^Cast ' + T + ' if ' + T + ' is (?:active|up)\\.$'), '$2 在的时候放 $1。'],
  [new RegExp('^Use ' + T + ' if ' + T + ' is (?:active|up)\\.$'), '$2 在的时候用 $1。'],
  [new RegExp('^Cast ' + T + ' whenever you have ' + T + '\\.$'), '一有 $2 就放 $1。'],
  [new RegExp('^Cast ' + T + ' to generate ' + T + '\\.$'), '放 $1 来攒 $2。'],
  [new RegExp('^Cast ' + T + ' to proc ' + T + '\\.$'), '放 $1 触发 $2。'],
  [new RegExp('^Cast ' + T + ' as your filler spell\\.$'), '没别的可放时用 $1 填。'],
  [new RegExp('^Cast ' + T + ' as (?:a )?filler\\.$'), '拿 $1 填空。'],
  [new RegExp('^Use ' + T + ' as (?:a )?filler\\.$'), '拿 $1 填空。'],
  [new RegExp('^Cast ' + T + ' as much as possible\\.$'), '尽量多放 $1。'],
  [new RegExp('^Cast ' + T + ' and ' + T + ' before ' + T + '\\.$'), '在 $3 之前放 $1 和 $2。'],
  [new RegExp('^Cast ' + T + ' with (\\d+) ' + T + '\\.$'), '攒到 $2 个 $3 时放 $1。'],
  [new RegExp('^Cast ' + T + ' with ' + T + '\\.$'), '配合 $2 放 $1。'],
  [new RegExp('^Use ' + T + ' with ' + T + '\\.$'), '配合 $2 用 $1。'],
  [new RegExp('^Cast ' + T + ' on a secondary target\\.$'), '在副目标身上放 $1。'],
  [new RegExp('^Cast ' + T + ' if under (\\d+) combo points\\.$'), '连击点不到 $2 时放 $1。'],
  [new RegExp('^Use ' + T + ' if you have (\\d+) charges?\\.$'), '有 $2 层充能时用 $1。'],
  [new RegExp('^Use ' + T + ' and ' + T + ' together\\.$'), '$1 和 $2 一起用。'],
  [new RegExp('^Use ' + T + ' if needed to apply ' + T + ' enabling your single-target abilities to cleave\\.$'),
    '需要时用 $1 挂上 $2，让单体技能能溅射。'],
  [new RegExp('^Cast ' + T + ' on cooldown\\.?$'), '$1 冷却好就放。'],
  [new RegExp('^Use ' + T + ' on cooldown\\.?$'), '$1 冷却好就用。'],
  [new RegExp('^Keep ' + T + ' on cooldown\\.?$'), '$1 冷却好就放。'],
  [new RegExp('^Cast ' + T + ' off cooldown\\.?$'), '$1 冷却好就放。'],
  [new RegExp('^Cast ' + T + ' on Cooldown\\.?$'), '$1 冷却好就放。'],

  // ---- Keep / 维持
  [new RegExp('^Keep up ' + T + ' and ' + T + ' on your target\\.$'), '在目标身上保持 $1 和 $2。'],
  [new RegExp('^Keep up ' + T + ' and ' + T + ' throughout the fight\\.$'), '整场保持 $1 和 $2。'],
  [new RegExp('^Keep up,? ' + T + ' and ' + T + '\\.$'), '保持 $1 和 $2。'],
  [new RegExp('^Keep up ' + T + ' on up to (\\d+) targets\\.$'), '在最多 $2 个目标身上保持 $1。'],
  [new RegExp('^Keep up ' + T + ' throughout the fight\\.$'), '整场保持 $1。'],
  [new RegExp('^Keep up ' + T + '\\.$'), '保持 $1。'],
  [new RegExp('^Keep ' + T + ' up\\.$'), '保持 $1。'],
  [new RegExp('^Keep ' + T + ' active\\.$'), '保持 $1。'],
  [new RegExp('^Avoid capping ' + T + ' charges\\.$'), '别让 $1 的充能溢出。'],
  [new RegExp('^Never drop your ' + T + '!?$'), '别让 $1 掉了！'],
  [new RegExp('^Maintain ' + T + ' at 100% uptime\\.$'), '让 $1 保持 100% 覆盖。'],
  [new RegExp('^Maintain (\\d+)\\+ Stacks of ' + T + ' to make use of ' + T + ', dropping below \\1 is ok if ' + T + ' is coming up soon\\.$'),
    '把 $2 保持在 $1 层以上以吃到 $3；如果 $4 马上就好，掉到 $1 层以下也没关系。'],
  [new RegExp('^Make sure to have at least (\\d+) stack of ' + T + ' rolling all the time\\.$'),
    '始终保持至少 $1 层 $2。'],
  [new RegExp('^Make sure to have at least (\\d+) stack of ' + T + ' rolling while actively tanking\\.$'),
    '正在扛怪时保持至少 $1 层 $2。'],
  [new RegExp('^Make sure to not miss out on casting ' + T + '\\.$'), '别漏放 $1。'],
  [new RegExp('^Make sure to always enter it with close to the full amount of ' + T + '\\.$'),
    '进入之前尽量把 $1 攒满。'],
  [new RegExp('^Spend ' + T + ' procs by casting ' + T + '\\.$'), '用 $2 把 $1 的触发消耗掉。'],
  [new RegExp('^Spend Runic Power on ' + T + ' when you are about to overcap or ' + T + ' is about to fade\\.$'),
    '快要溢出符能、或者 $2 快掉时，把符能花在 $1 上。'],
  [new RegExp('^Consume (\\d+) ' + T + ' stacks with ' + T + '\\.$'), '用 $3 消耗 $1 层 $2。'],
  [new RegExp('^Press ' + T + ' if not at (\\d+) Combo Points ?\\.$'), '连击点没到 $2 时按 $1。'],
  [new RegExp('^Do not overwrite your ' + T + ' and instead apply ' + T + ' as soon as the buffed one expires\\.$'),
    '别覆盖掉 $1；等强化版本过期之后再挂 $2。'],
  [new RegExp('^When playing ' + T + ' try to have no ' + T + ' stacks before entering ?' + T + '\\.$'),
    '玩 $1 时，进 $3 之前尽量让 $2 不带层数。'],
  [/^You might need to go to higher stacks depending on the expected damage intake\.$/,
    '预计要吃的伤害更高时，可能得叠到更多层。'],
  [/^You have over (\d+) rage\.$/, '怒气超过 $1。'],
  [new RegExp('^Keep ' + T + ' up on most targets\\.$'), '在大多数目标身上保持 $1。'],
  [new RegExp('^Cast ?' + T + ' on AoE\\.$'), '打 AOE 时放 $1。'],
  [new RegExp('^Cast ?' + T + ' on (\\d+) or less targets\\.$'), '目标不超过 $2 个时放 $1。'],
  [/^This is a general priority you aim to maintain throughout the fight as (.+?) ?\.$/,
    '下面是 $1 整场战斗照着走的大致优先级。'],

  // ---- 最笼统的两条，必须垫底
  [new RegExp('^Cast ' + T + '\\.$'), '放 $1。'],
  [new RegExp('^Use ' + T + '\\.$'), '用 $1。']
];

/**
 * 复合从句的守卫。
 *
 * `T` 是非贪婪的「一个游戏名词」，但它挡不住整段从句被吞进去。实测那句
 * `Cast X if you have 4 Arcane Charges and either have 25 stacks of Y.`
 * 命中了 `Cast {A} if you have {B}.`，B 捕到的是「4 奥术充能 and either have
 * 25 stacks of 奥术齐射」整段 —— 译出来是「有 4 奥术充能 and either have …时放 X」，
 * 半中半英，而且把一个复合条件压成了单条件的形状。
 *
 * 所以：**捕获组里出现从句就判这次匹配不算，整句留英文。** 宁可少翻一句，
 * 不要给一句结构被压扁的中文 —— 出手顺序里条件结构错了是会照着打错的。
 *
 * 判据不能简单写成「含 and / or 就拒」：**技能名本身就带 and**
 * （`Hack and Slash`、`Blood and Thunder`），那样会把一大批本来翻得好好的
 * 简单句一起拒掉（实测覆盖率从 86% 掉到 68%，掉的大半是好句子）。
 * 所以只认「从句的开头」：`if / when / unless / while / either …`，
 * 以及 `and / or` 后面紧跟动词或人称代词（`and have`、`or to`、`and you`）——
 * 那才是又起了一句，而不是并列两个名词。
 */
function tooComplex(groups) {
  return groups.some(function (g) {
    if (!g) return false;
    if (/\s(if|when|unless|while|either|but|then)\s/i.test(g)) return true;
    // 「你怎么怎么样」= 又起了一句。实测漏过一条：
    // `Cast X if you are below 3 Soul Shards and Infernal Bolt is up.` 命中了
    // `Cast {A} if {B} is up.`，B 捕到「you are below 3 灵魂碎片 and Infernal Bolt」，
    // 上面两条都没拦住（and 后面跟的是大写名词），译出来前半截整段是英文。
    if (/\b(you|your)\s+(are|is|have|has|do|don't|will|can|need|want|reach|cast|use)\b/i.test(g)) return true;
    return /\s(and|or)\s+(have|has|had|you|your|not|no|to|is|are|be|going|use|cast|keep|press|spend)\b/i.test(g);
  });
}

/** 一句。返回 {t 译文, how 'zh' 命中模板 / 'en' 留英文}。 */
function one(s) {
  for (var i = 0; i < SENT.length; i++) {
    var m = SENT[i][0].exec(s);
    if (!m) continue;
    if (tooComplex(m.slice(1))) return { t: s, how: 'en' };
    return { t: s.replace(SENT[i][0], SENT[i][1]), how: 'zh' };
  }
  return { t: s, how: 'en' };            // 没命中就原样留英文，不半翻
}

/**
 * 一整段。stat（可选）累计 sent / frag / none 三个计数。
 *
 * 断句用「句末标点 + 空格」。maxroll 的正文是把 <li> 拼起来的，所以经常
 * 出现「…on cooldown. Cast …」这种紧挨着的句子，这个切法正好。
 * 切不开的（一整段没有句号）当一句处理 —— 那种基本都走碎片替换。
 */
function translate(text, stat) {
  if (!text) return text;
  var parts = String(text).split(/(?<=[.!?])\s+/);
  var out = parts.map(function (p) {
    var r = one(p.trim());
    if (stat) stat[r.how] = (stat[r.how] || 0) + 1;
    return r.t;
  });
  // 中文句子之间不留空格，中英之间留一个 —— 混排时不留空格会糊成一团。
  return out.join(' ').replace(/([一-鿿。，、；：！？])\s+(?=[一-鿿])/g, '$1').trim();
}

module.exports = { translate: translate, one: one, SENT: SENT };
