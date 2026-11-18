# vuln-exceptions の fixture(実物。取得日 2026-11-18)

`scripts/vuln-exceptions.test.mjs` が読む。中身は取得したままで、手で書き換えない(書き換えるならテストに作った値として書く)。

| ファイル | 取り方 | 何を確かめるのに使うか |
|---|---|---|
| `npm-audit-aisho-shindan.json` | `cd ~/sites/aisho-shindan && npm audit --json`(コミット a1cff4b の lockfile) | 公表は picomatch の GHSA-fc5q-39xc-vjpf(high)1件だけ。ほかの high 11 件は「別の部品経由」の文字列 |
| `GHSA-fc5q-39xc-vjpf.json` | `curl https://api.osv.dev/v1/vulns/GHSA-fc5q-39xc-vjpf` | picomatch。`last_affected` だけ=修正版なし |
| `GHSA-r3h5-4585-7x3w.json` | `curl https://api.osv.dev/v1/vulns/GHSA-r3h5-4585-7x3w` | 同じ応答に astro(`fixed` あり)と @astrojs/node(`last_affected` だけ)が並ぶ |
