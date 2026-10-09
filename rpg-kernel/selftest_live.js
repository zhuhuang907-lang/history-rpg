'use strict';
/* 联网实测：dossier.identify 对已知人物的抽取与年龄计算（用于确认「身份/年龄/位置/事件按搜索来」）。 */
const D = require('./core/dossier');

async function tryIdentify(name, year, polity) {
  process.stdout.write(`\n→ identify(${name}, ${year}, ${polity}) ... `);
  try {
    const d = await D.identify(name, year, polity);
    console.log('done');
    console.log('  found :', d.found);
    if (d.found) {
      console.log('  born/died:', d.born, d.died, ' age@' + year + ':', d.age);
      console.log('  role  :', d.role, '(', d.roleVia, ')');
      console.log('  native:', d.nativePlace, ' place:', d.place, ' gender:', d.gender);
      console.log('  fits  :', JSON.stringify(d.fits));
      console.log('  events:', (d.events || []).map(e => e.year + ' ' + e.text).join(' | '));
      console.log('  qid   :', d.qid);
      console.log('  note  :', d.note || '(无)');
    } else {
      console.log('  why   :', d.why);
      console.log('  allSourcesFailed:', d.allSourcesFailed);
    }
    console.log('  sources:', (d.sources || []).map(s => s.label + ':' + s.provider).join(', '));
    return d;
  } catch (e) {
    console.log('ERROR:', e.message);
    return null;
  }
}

(async () => {
  await tryIdentify('杜伏威', 615, '隋');
  await tryIdentify('刘展', 762, '唐');
})().catch(e => { console.error('fatal', e); process.exit(1); });
