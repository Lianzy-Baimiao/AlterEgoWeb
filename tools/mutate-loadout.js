/*
 * WowAltBoard - tools/mutate-loadout.js
 *
 * 天赋导入串那一组断言的变异测试。
 *
 * 起因（这一轮真实发生的两次假绿，值得写在最前面）：
 *   1. 复制桩被我写了两遍，第二个只存字符串、覆盖了存对象的那个，于是
 *      copied[0].text 恒为 undefined —— 43 个专精全报「复制出去的串和显示的
 *      不是同一串」。那不是面板的错，是**仪器**的错。
 *   2. 修好之后套件全绿，但导入串的计数一个都没打印、也没有下界断言。
 *      truth 取不到时那 43 条断言全部提前 return，「一个专精都没画出串框」
 *      会安静地全绿通过。
 * 两次都是同一个形状：跳过报成通过。所以这一组断言必须自己证明能失败。
 *
 * 严格程度跟 mutate-icons.js 一档：**每个变异体必须让指定的那句话出现在
 * 输出里**，光「退出码非 0」不算抓到 —— 被别的断言抓走的话，被测的那条
 * 依然可能是摆设。锚点失效同样算失败。
 *
 * 用法：node tools\mutate-loadout.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var lock = require('./mutate-lock.js');

var ROOT = path.resolve(__dirname, '..');
var BIS = path.join(ROOT, 'app', 'bis.js');
var RUNNER = path.join(__dirname, 'run-tests.js');

lock.acquire('mutate-loadout');
process.on('exit', lock.release);

function run() {
  var r = cp.spawnSync(process.execPath, [RUNNER],
    { cwd: ROOT, encoding: 'utf8', env: lock.childEnv() });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * 一个文本变异体。
 *
 * 锚点必须**在文件里正好出现一次**。只判「找不到」是不够的：本轮就有一条锚点
 * （box.appendChild(bar);）在 bis.js 里出现两次 —— 导入串这块一次，天赋树的
 * 「套路」条一次。String.replace 只换第一处，而它恰好是我想改的那处，于是变异
 * 「碰巧」有效。那是靠代码顺序的侥幸：把两块的顺序调一下，这个变异体就会去改
 * 天赋树，然后被别的断言抓住，报「抓到」，而导入串的断言一次都没被验证。
 * 所以重复锚点和缺失锚点一样，直接算锚点失效。
 */
function textMutant(desc, file, from, to, want) {
  return {
    desc: desc, want: want,
    apply: function () {
      var orig = fs.readFileSync(file, 'utf8');
      var n = orig.split(from).length - 1;
      if (n !== 1) {
        console.log('    锚点在文件里出现 ' + n + ' 次（必须正好 1 次）');
        return null;                                    // 锚点失效 = 失败
      }
      fs.writeFileSync(file, orig.replace(from, to));
      return function () { fs.writeFileSync(file, orig); };
    }
  };
}

var MUTANTS = [
  // 整块不画。这条抓的是「功能没了但套件不知道」——也就是下界断言的意义。
  //
  // want 这里踩过一次：我原本填「导入串只检查了」，结果报「串了」。
  // 原因是 loRenders / loSeen 在「块数对不对」之前就记了，所以专精数照样是 40，
  // 真正触发的是块数那条。填错 want 的代价不是漏报而是**误判**：
  // 断言其实好的，变异测试却说它没被证明。
  textMutant('导入串块整块不画', BIS,
    'if (lo) host.appendChild(lo);',
    '/* mutant: 导入串块没挂上去 */',
    '各应正好 1 个'),

  // 显示的串被改一个字符。串长、字符集、人数全都正常，只有逐字节比对能抓。
  // 这是导入串唯一致命的失败方式：粘进游戏得到「无效」，而界面看不出问题。
  textMutant('显示的串被改掉一个字符', BIS,
    'ta.value = str;',
    "ta.value = str.slice(0, -1) + (str.slice(-1) === 'A' ? 'B' : 'A');",
    '和 rio 数据里的第一条不一致'),

  // 复制的和显示的不是同一串（复制第二热门的那条）。
  // 前面所有断言都在看 DOM 里的文字，只有真点一次按钮才能抓到这条。
  textMutant('复制按钮交出另一条串', BIS,
    "if (AE.copyWithToast) AE.copyWithToast(str, '天赋导入串');",
    "if (AE.copyWithToast) AE.copyWithToast(lo.list[(idx + 1) % lo.list.length], '天赋导入串');",
    '复制出去的串和框里显示的不是同一串'),

  // 串框可写。用户改一个字符再复制，导进游戏只会说「无效」。
  textMutant('串框改成可写', BIS,
    'ta.readOnly = true;',
    'ta.readOnly = false;',
    '不是只读的'),

  // 排序去掉。Object.keys 的顺序一变，「#1 热门」指的就是另一串了。
  // 这条抓的是「显示的第一条必须是真正最热门的那条」。
  textMutant('热门排序去掉', BIS,
    'if (count[b] !== count[a]) return count[b] - count[a];',
    'if (false) return count[b] - count[a];',
    '和 rio 数据里的第一条不一致'),

  // 串头 specID 被换成别的专精的串。串长、字符集、只读、复制一致 —— 全过，
  // 只有「串头里的 specID 必须是本专精」能抓。导错专精游戏直接拒绝。
  textMutant('拿另一个专精的串来显示', BIS,
    'var str = lo.list[idx];',
    'var str = (function () {\n'
      + '      var R = rio(), ks = R && R.specs ? Object.keys(R.specs) : [];\n'
      + '      for (var i = 0; i < ks.length; i++) {\n'
      + '        var o = R.specs[ks[i]];\n'
      + '        if (String(ks[i]) !== String(s.specId) && o && o.loadouts && o.loadouts[0]) {\n'
      + '          return o.loadouts[0];\n'
      + '        }\n'
      + '      }\n'
      + '      return lo.list[idx];\n'
      + '    })();',
    '不是本专精'),

  // 空转守卫 1：复制那条断言的计数分支关掉 -> loCopy 变 0。
  // 没有这条下界，「复制内容与显示相同」在一次都没点的情况下也是「全对」。
  textMutant('复制断言一次都不跑（证明 loCopy 下界不是空的）', RUNNER,
    '  } else {\n    stats.loCopy++;',
    '  } else if (false) {\n    stats.loCopy++;',
    '复制按钮验过'),

  // 空转守卫 2：真值取不到时，全部断言会提前 return。这正是第 2 次假绿的形状。
  textMutant('真值恒为空（证明「跳过」不会报成通过）', RUNNER,
    'function rioLoadoutTruth(specId) {',
    'function rioLoadoutTruth(specId) {\n  if (true) return null;',
    '导入串只检查了'),

  // 选串按钮数。这条单独列出来，因为它是用户唯一能换串的入口：
  // 按钮没了的话界面只剩最热门那一条，而所有逐字节断言依然全绿。
  // 注意锚点必须带上下文：'box.appendChild(bar);' 这一句在 bis.js 里有**两处**
  // （导入串的选串条、天赋树的套路条）。只写这一句的话 replace 命中的是
  // 先出现的那处 —— 这一轮它恰好就是导入串，但「恰好」不是证明。
  // textMutant 现在会拒绝出现多次的锚点，所以这里必须写唯一形式。
  textMutant('选串按钮不画', BIS,
    'bar.appendChild(b);\n    });\n    box.appendChild(bar);',
    'bar.appendChild(b);\n    });\n    /* mutant: 选串按钮整排没挂上去 */',
    '选串按钮')
];

console.log('=== 天赋导入串断言的变异测试 ===');

var base = run();
if (base.status !== 0) {
  console.log('基线就是红的，变异测试没有意义。先把套件修绿。');
  console.log(base.out.split('\n').slice(-12).join('\n'));
  process.exit(1);
}
console.log('基线通过。');

var caught = 0, missed = [], dead = [], wrong = [];

MUTANTS.forEach(function (m) {
  var restore = m.apply();
  if (!restore) {
    dead.push(m.desc);
    console.log('  锚点失效  ' + m.desc);
    return;
  }
  var r;
  try { r = run(); } finally { restore(); }
  if (r.status === 0) {
    missed.push(m.desc);
    console.log('  漏了  ' + m.desc);
  } else if (r.out.indexOf(m.want) < 0) {
    wrong.push(m.desc + '（没出现「' + m.want + '」）');
    console.log('  串了  ' + m.desc + '：输出里没有「' + m.want + '」');
  } else {
    caught++;
    console.log('  抓到  ' + m.desc + '　→「' + m.want + '」');
  }
});

var after = run();
console.log('\n变异 ' + MUTANTS.length + '，抓到 ' + caught + '，漏 ' + missed.length
  + '，串 ' + wrong.length + '，锚点失效 ' + dead.length
  + '；还原后套件 ' + (after.status === 0 ? '仍然通过' : '没恢复（有问题）'));
missed.forEach(function (s) { console.log('  · 漏：' + s); });
wrong.forEach(function (s) { console.log('  · 串：' + s); });
dead.forEach(function (s) { console.log('  · 锚点失效：' + s); });
process.exit(missed.length + wrong.length + dead.length || after.status !== 0 ? 1 : 0);
