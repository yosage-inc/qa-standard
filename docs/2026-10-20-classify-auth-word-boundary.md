# classify-release.mjs の L3 グロブ `**/*auth*` を「語の照合」に(2026-10-20 記録)

## 何が問題だったか

`DEFAULT_POLICY.l3_paths` の `"**/*auth*"` は、ファイル名のどこかに `auth` があれば L3(最重量の QA)にする。
`auth`(認証)だけでなく `author` / `authors`(書き手)にも当たるので、`src/content/authors/`・`data/authors.json` の
ような**コンテンツ更新が毎回 L3**(SAST+依存脆弱性+DAST、約10分)になる。
2026-10-19 にモバイル版 `~/yosage-appqa/scripts/judge_level.sh` で `developing` の中の `pin` が M3 の理由に挙がる
誤検知を直した際に、同じ型として見つかった。

### 実在するか・増えそうか(全履歴で実測)

qa-standard を呼んでいる5リポジトリ(sauna-portal / tosou-soba / reform-soba / kazoeru / daicho)と、未導入の
jikkajimai-annai・会社サイト yosage-inc の全履歴パス(`git log --all --name-only` + `git ls-files` + 未追跡)を洗った。

| リポジトリ | 全パス | `auth` を含むパス | 内訳 |
|---|---|---|---|
| sauna-portal | 178 | 0 | — |
| jikkajimai-annai | 321 | 0 | — |
| tosou-soba | 311 | 0 | — |
| reform-soba | 146 | 0 | — |
| kazoeru | 880 | 0 | — |
| daicho(SaaS。CI で classify も通す) | 82 | 3 | `apps/api/src/core/auth.ts` `…/db/auth-schema.ts` `apps/api/test/authz.test.ts`(すべて認証=真陽性) |
| yosage-inc | 26 | 0 | — |

`author*` は現時点でどこにも無い。それでも直したのは、メディア5サイトで著者・編集体制のページや構造化データ
(`Article` の `author`)は E-E-A-T・AdSense 再審査の文脈で増える余地があり、増えた後に気づくと「記事更新のたびに L3」で
Actions の無料枠(月2,000分)を食うため。直す側のコストは小さく、自己テストと全コミット回帰で安全を確かめられる。

## どう直したか

- ポリシーに `l3_words` を新設し、`DEFAULT_POLICY.l3_paths` と `config/qa-policy.example.json` から `"**/*auth*"` を外した。
  ```json
  "l3_words": {
    "stems":  ["auth", "oauth", "unauth"],
    "except": ["author", "authors", "authored", "authoring", "authorial", "authorship"]
  }
  ```
- 照合: パスを「語」に分け(英字以外と camelCase の山で区切り、小文字に)、**どれかの語の先頭が `stems` に一致すれば L3。
  `except` の語(完全一致)は数えない**。語の分け方は `~/yosage-appqa` / `~/yosage-webqa` の `judge_lib.sh` と同じ決まり。
  - 当たる: `auth.ts` `Auth.ts` `src/auth/index.js`(グロブ `**/auth/**` でも) `login-auth.js` `LoginAuth.ts` `useAuth.ts`
    `authorize.ts` `authentication.ts` `authz.test.ts` `oauth.ts` `unauthorized.ts` `AUTHZ.JS`
  - 当たらない: `authors.json` `src/content/authors/x.md` `authors.js` `AuthorCard.astro` `coauthor.js`
- `oauth` `unauth` を語幹に明示したのは、語頭ルールでは `oauth` / `unauthorized` に `auth` が当たらなくなる
  (旧グロブでは当たっていた)ため。`author` 系を `except` の**完全一致**にしたのは、`authoriz*`(認可)が `author` で
  始まるので接頭辞では分けられないから。閉じた語の一覧なので、`authorize` `authority` `authorlist` のような語は
  一覧に無い限り当たる(安全側)。
- グロブ(`globToRegExp`)は大小文字を見ない(`i` フラグ)ので、`**/*Auth*` のような camelCase の境界はグロブでは書けない。
  そのため「語の照合」をグロブとは別の仕組みにした。
- 他の L3 グロブ(`**/session*` `**/payment*` `**/*cookie*` など)はそのまま。`**/*cookie*` も部分一致だが、
  `cookie` を途中に含む別の語は現実のパスに見当たらないので触っていない。

変更ファイル: `scripts/classify-release.mjs` / `scripts/classify-release.test.mjs`(16件追加) /
`config/qa-policy.example.json` / この記録。`README.md` は別セッションが同日に編集中だったので触っていない
(次に README を直すときに、構成表か導入手順の「qa-policy.json」の項に `l3_words` の一言を足す)。

## 新旧比較(真陽性が残り、判定が変わらないことの確認)

### 全履歴パスに旧グロブ `**/*auth*` と新 `l3_words` を当てた

7リポジトリ 1,944 パスで、旧で当たる 3 件(daicho の認証ファイル)は新でも当たり、**新で増えた 0・外れた 0**。

### 全コミットで旧 classify と新 classify を回した

各リポジトリの `git rev-list --all` の全コミットについて「親 → そのコミット」(従来モード)で旧と新を実行し、
`level` と `reason` を突き合わせた(作業ツリーの `qa-policy.json` を使うので、tosou-soba / kazoeru は自前の
`l3_paths` で判定される)。

| リポジトリ | コミット | 一致 | 差 | 新の内訳 |
|---|---|---|---|---|
| sauna-portal | 113 | 113 | 0 | L0 21 / L1 5 / L2 71 / L3 16 |
| jikkajimai-annai | 147 | 147 | 0 | L0 50 / L1 35 / L2 33 / L3 29 |
| tosou-soba | 132 | 132 | 0 | L0 47 / L1 22 / L2 30 / L3 33 |
| reform-soba | 109 | 109 | 0 | L0 31 / L1 19 / L2 25 / L3 34 |
| kazoeru | 129 | 129 | 0 | L0 32 / L1 19 / L2 53 / L3 25 |
| daicho | 27 | 27 | 0 | L0 8 / L1 4 / L2 10 / L3 5 |
| yosage-inc | 28 | 28 | 0 | L0 10 / L1 7 / L2 9 / L3 2 |
| **合計** | **685** | **685** | **0** | |

## 自己テストと「壊して赤を見る」(docs/test-quality-standard.md §3-6)

- 本体: `node scripts/classify-release.test.mjs` → **32 件 全件 PASS**(既存16 + 今回16)
- 変異1 `except`(author 系の除外)を空にする → 4 件失敗(`authors/taro.md` `authors.json` `authors.js` `AuthorCard.js` が L3)
- 変異2 `stems` を空にする(語の照合を止める) → 10 件失敗(`Auth.js` `login-auth.js` `useAuth.js` `oauth.js` … が L1)
- 変異3 camelCase の山で区切らない → 3 件失敗(`AuthorCard.js` が L3・`LoginAuth.js` `useAuth.js` が L1)
- 変異4 語頭一致を語の中の部分一致にする → 1 件失敗(`coauthor.js` が L3)
- 変異5 旧グロブ `**/*auth*` を戻す → 4 件失敗(`authors.json` `authors.js` `AuthorCard.js` `coauthor.js` が L3)
- 変異は使い捨てのコピーで行い、本体には触れていない。
- テストの作りで1つ学び: 全部大文字の例を `src/AUTH.JS` にすると、大小文字を区別しない macOS のファイルシステムでは
  既存の `src/Auth.js` と同じファイルになり、git が `Auth.js` の変更として見る(理由にそのパスが出ない)。
  別の名前(`src/api/AUTHZ.JS`)にした。

## 残した判断・次にやること

1. **tosou-soba と kazoeru の `qa-policy.json` は `l3_paths` を丸ごと上書きしていて、自前の `"**/*auth*"` を持つ**。
   この2サイトでは `author*` が引き続き L3 になる(安全側。今日の履歴には存在しない)。`l3_words` は既定が効くので
   足す必要はなく、`"**/*auth*"` の1項目を外すだけ。push 1回で QA+デプロイが1本走る(無料枠)うえ、2026-10-14 から
   成果物の保存枠超過でデプロイが止まっているので、**それだけの push はせず、次にそのリポジトリへ push する作業に同乗させる**。
2. `authority`(権威)や `authorlist` のような語は `except` に無いので L3 のまま(安全側の過検知)。実害が出たら一覧に足す。
3. `README.md` の構成表・導入手順に `l3_words` の説明を足す(別セッションの編集が落ち着いてから)。
