// quoteArg / quoteArgWin 回归测试。
// 背景（实测发现）：原实现照搬 POSIX 转义，把每个反斜杠都变成 \\，
// 于是 runDsh 传给 dsh 的 Windows 路径全是双反斜杠——本地盘符被 Windows 容错掉
// （e2e 因此未暴露），UNC 路径则直接失效。这里锁定 MSVCRT 规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteArg, quoteArgWin } from '../src/compose.mjs';

test('quoteArgWin：普通反斜杠路径不被加倍（原 bug：C:\\Temp\\x → C:\\\\Temp\\\\x）', () => {
  assert.equal(quoteArgWin('C:\\Temp\\x.yml'), '"C:\\Temp\\x.yml"');
  assert.equal(quoteArgWin('C:\\Temp\\a b\\x.yml'), '"C:\\Temp\\a b\\x.yml"');
});

test('quoteArgWin：UNC 路径保持原样（双反斜杠被加倍会使其失效）', () => {
  assert.equal(quoteArgWin('\\\\server\\share\\x.yml'), '"\\\\server\\share\\x.yml"');
});

test('quoteArgWin：内嵌双引号转义为 \\"', () => {
  assert.equal(quoteArgWin('has"quote'), '"has\\"quote"');
  assert.equal(quoteArgWin('a"b"c'), '"a\\"b\\"c"');
});

test('quoteArgWin：紧邻引号或结尾的连续反斜杠才加倍', () => {
  assert.equal(quoteArgWin('trail\\'), '"trail\\\\"', '结尾反斜杠加倍，避免吃掉收尾引号');
  assert.equal(quoteArgWin('trail\\\\'), '"trail\\\\\\\\"');
  assert.equal(quoteArgWin('a\\"b'), '"a\\\\\\"b"', '引号前的反斜杠加倍');
  assert.equal(quoteArgWin('mid\\dle'), '"mid\\dle"', '中间反斜杠不变');
});

test('quoteArgWin：普通名与空串', () => {
  assert.equal(quoteArgWin('plain'), '"plain"');
  assert.equal(quoteArgWin(''), '""');
});

test('quoteArg：POSIX 分支单引号包裹并转义单引号', () => {
  if (process.platform === 'win32') {
    assert.equal(quoteArg('a b'), '"a b"', 'win32 走 quoteArgWin');
  } else {
    assert.equal(quoteArg("it's"), "'it'\\''s'");
    assert.equal(quoteArg('a b'), "'a b'");
  }
});
