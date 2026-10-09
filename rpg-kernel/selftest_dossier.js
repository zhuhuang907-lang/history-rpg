'use strict';
/* 离线自测：dossier 纯函数 + 皇帝错选纠正逻辑（不联网） */
const D = require('./core/dossier');

let fails = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL: ' + msg); fails++; }
  else console.log('  ✓ ' + msg);
}

console.log('== parseLifeSpan ==');
let ls = D.parseLifeSpan('李斯（约前284年－前208年），战国末期至秦朝政治家');
assert(ls.born === -284 && ls.died === -208, `前284-前208 => ${JSON.stringify(ls)}`);
ls = D.parseLifeSpan('欧阳修（1007年8月6日－1072年9月22日），北宋政治家');
assert(ls.born === 1007 && ls.died === 1072, `带月日 1007-1072 => ${JSON.stringify(ls)}`);

console.log('== parseRole ==');
let r = D.parseRole('李斯，秦朝丞相，助秦始皇统一六国', '李斯');
assert(/丞相/.test(r.role) && /秦朝/.test(r.dynasty), `李斯=>丞相/秦朝 => ${JSON.stringify(r)}`);
r = D.parseRole('杜伏威，隋末江淮起义军首领', '杜伏威');
assert(/起义军|首领/.test(r.role), `杜伏威=>起义军首领 => ${JSON.stringify(r)}`);

console.log('== parseNative ==');
let n = D.parseNative('上蔡（今河南省上蔡县）人');
assert(n === '上蔡', `上蔡 => ${n}`);
n = D.parseNative('为秦相吕不韦的舍人，深知宫闱秘事');
assert(!n || !/舍/.test(n), `不应吞掉「为秦相吕不韦的舍」 => ${JSON.stringify(n)}`);

console.log('== parsePlace（best-effort，禁止吞虚词/职衔） ==');
let pl = D.parsePlace('他奉命知益州，治理民政');
assert(pl === '益州', `知益州 => ${pl}`);
let plc = D.parsePlace('他奉命镇守长安，安抚百姓');
assert(plc === '长安', `镇守长安 => ${plc}`);
let plb = D.parsePlace('刺史荆州，威震一方');
assert(plb === '荆州', `刺史荆州 => ${plb}`);
let plx = D.parsePlace('以参知政事主持朝政');
assert(plx === '', `参知政事 不应吞成政事 => ${JSON.stringify(plx)}`);
let ply = D.parsePlace('两人落草为寇，时年十六');
assert(ply === '', `落草为寇 不应吞成落草 => ${JSON.stringify(ply)}`);
let plz = D.parsePlace('隋末农民起义军领导者之一');
assert(plz === '', `领导者之一 不应吞成导者之一 => ${JSON.stringify(plz)}`);

console.log('== classifyIdentity / roleIsRuler ==');
assert(D.roleIsRuler('唐朝皇帝'), 'roleIsRuler 唐朝皇帝=true');
assert(!D.roleIsRuler('隋朝将军'), 'roleIsRuler 隋朝将军=false');
assert(D.classifyIdentity('隋末江淮起义军首领') === 'warlord', `起义军=>warlord`);
assert(D.classifyIdentity('唐朝皇帝') === 'emperor', '皇帝=>emperor');
assert(D.classifyIdentity('北宋政治家、文学家') === 'official', '政治家=>official(兜底)');

console.log('== applyToState + renderDossier ==');
const state = {
  protagonist: { name: '杜伏威', age: 20, role: '（身份待定）', nativePlace: '', gender: '男', birthYear: 0 },
  location: { full: '待定' },
  anchors: {},
};
const d = {
  found: true, name: '杜伏威', born: 598, died: 624, age: 18, gender: '男',
  role: '隋末江淮起义军首领', nativePlace: '齐州章丘', place: '历阳',
  events: [{ year: 613, text: '613年起兵反隋' }], qid: 'Q123', excerpt: '杜伏威，隋末江淮起义军首领。',
};
const ch = D.applyToState(state, d, { force: true });
assert(state.protagonist.age === 18, `年龄纠正为18 => ${state.protagonist.age}`);
assert(state.protagonist.role === '隋末江淮起义军首领', `身份纠正 => ${state.protagonist.role}`);
assert(state.anchors.birthPlace === '齐州章丘', `birthPlace => ${state.anchors.birthPlace}`);
assert(state.anchors.officeHistory === '隋末江淮起义军首领', `officeHistory => ${state.anchors.officeHistory}`);
const rd = D.renderDossier(state);
assert(/杜伏威/.test(rd) && /隋末江淮起义军首领/.test(rd), `renderDossier 含身份`);

console.log('== 皇帝错选纠正逻辑（与 engine 内一致） ==');
function decideCorrection(identityModule, role) {
  if (identityModule === 'emperor' && !D.roleIsRuler(role)) return D.classifyIdentity(role);
  return identityModule;
}
assert(decideCorrection('emperor', '隋末江淮起义军首领') === 'warlord', '皇帝错选杜伏威=>warlord');
assert(decideCorrection('emperor', '唐朝皇帝') === 'emperor', '真皇帝不变');
assert(decideCorrection('official', '隋末江淮起义军首领') === 'official', '非皇帝不纠正');

console.log(fails ? `\n结果：${fails} 项失败` : '\n结果：全部通过');
process.exit(fails ? 1 : 0);
