#!/bin/bash
# drill-guard.test.sh — drill-guard-pre-push.sh の自己テスト(依存は git だけ・0 円)
#
# 使い方:  ~/qa-standard/scripts/drill-guard.test.sh
#   全部 PASS → exit 0 / 1 つでも FAIL → exit 1
#   DRILL_GUARD_HOOK=<path> で別のフック(わざと壊したコピー)を試せる=「壊して赤を見る」用
#
# 何を確かめるか(~/qa-standard/docs/test-quality-standard.md §3):
#   使い捨ての git リポジトリ(リモートはローカルの bare)にフックを入れ、実際に git push して
#   (a) メッセージに [seeded-defect] があるコミットの push が拒否される(件名・本文どちらでも)
#   (b) drill/ で始まる枝の push が拒否される(枝そのもの・別名での push・ローカル側だけ drill/ の場合)
#   (c) 普通のコミット・普通の枝・タグは通る。リモートの枝の削除も通る
#   (d) 既存フック(pre-push.local)の連結: 非 0 なら止まり、0 なら通る
#   期待値は「push が成功したか(リモートの参照が動いたか)」と「拒否文に drill-guard があるか」で決め、
#   フックの中身の手順は写していない。
# 直した人の義務: フックを 1 か所壊してこのテストが赤くなるのを見てから出す(§3-6)。

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${DRILL_GUARD_HOOK:-$SCRIPT_DIR/drill-guard-pre-push.sh}"
[ -f "$HOOK" ] || { echo "ERROR: フックが無い: $HOOK" >&2; exit 1; }

# 手元の git 設定(署名・hooksPath など)に左右されないようにする
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
unset GIT_DIR GIT_WORK_TREE
export GIT_AUTHOR_NAME=drill-test GIT_AUTHOR_EMAIL=drill-test@example.invalid
export GIT_COMMITTER_NAME=drill-test GIT_COMMITTER_EMAIL=drill-test@example.invalid

TMP=$(mktemp -d "${TMPDIR:-/tmp}/drill-guard-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT
REMOTE="$TMP/remote.git"; WORK="$TMP/work"; LOG="$TMP/push.log"
# 拒否の証拠はこの文で見る(一時ディレクトリ名の drill-guard と混同しないよう、文そのもので照合)
REJECT_TEXT='drill-guard: push を拒否しました'

PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS  $1"; }
ng() { FAIL=$((FAIL+1)); echo "FAIL  $1"; [ -n "${2:-}" ] && echo "      → $2"; }

g() { git -C "$WORK" "$@"; }
commit() { # commit <subject> [body]
  echo "$RANDOM $1" >> "$WORK/file.txt"; g add -A >/dev/null
  if [ -n "${2:-}" ]; then g commit -q -m "$1" -m "$2"; else g commit -q -m "$1"; fi
}
remote_sha() { git -C "$REMOTE" rev-parse -q --verify "refs/heads/$1" 2>/dev/null || echo none; }
# push <説明> <期待: ok|reject> <push 引数...>
push_expect() {
  local desc="$1" want="$2"; shift 2
  if g push "$@" >"$LOG" 2>&1; then got=ok; else got=reject; fi
  if [ "$got" = "$want" ]; then
    if [ "$want" = reject ] && ! grep -q "$REJECT_TEXT" "$LOG"; then
      ng "$desc" "拒否されたが drill-guard の理由文が無い: $(tail -3 "$LOG" | tr '\n' ' ')"
    else ok "$desc"; fi
  else
    ng "$desc" "期待=$want 実際=$got: $(tail -3 "$LOG" | tr '\n' ' ')"
  fi
}

# --- 使い捨てリポジトリ ---
git init -q --bare "$REMOTE"
git init -q -b main "$WORK"
g config commit.gpgsign false; g config tag.gpgsign false
g config core.hooksPath "$WORK/.git/hooks"
g remote add origin "$REMOTE"
cp "$HOOK" "$WORK/.git/hooks/pre-push"; chmod +x "$WORK/.git/hooks/pre-push"
commit "init"
push_expect "前提: 最初の普通の push は通る" ok -u origin main

echo "## (a) [seeded-defect] のコミットは拒否"
base=$(remote_sha main)
commit "[seeded-defect] drill 1 #1"
push_expect "a-1 件名にマーカー → 拒否" reject origin main
[ "$(remote_sha main)" = "$base" ] && ok "a-1 リモートの main が動いていない" || ng "a-1 リモートの main が動いた"
g reset -q --hard HEAD~1
commit "普通の件名" "本文の途中に [seeded-defect] がある"
push_expect "a-2 本文にマーカー → 拒否" reject origin main
g reset -q --hard HEAD~1
commit "普通 1"; commit "[seeded-defect] drill 1 #2"; commit "普通 2"
push_expect "a-3 3 コミットの真ん中にマーカー → 拒否(送る範囲を全部見る)" reject origin main
[ "$(remote_sha main)" = "$base" ] && ok "a-3 リモートの main が動いていない" || ng "a-3 リモートの main が動いた"
g reset -q --hard HEAD~3
commit "[seeded-defect] drill 1 #3"
push_expect "a-4 新しい枝(リモートに無い)にマーカー → 拒否" reject origin main:refs/heads/feature/new
[ "$(remote_sha feature/new)" = none ] && ok "a-4 リモートに feature/new ができていない" || ng "a-4 リモートに feature/new ができた"
g reset -q --hard HEAD~1

echo "## (b) drill/ で始まる枝は拒否"
g checkout -q -b drill/2026-10-20-albu
commit "訓練の枝だが普通の件名"
push_expect "b-1 drill/ の枝をそのまま push → 拒否" reject -u origin drill/2026-10-20-albu
[ "$(remote_sha drill/2026-10-20-albu)" = none ] && ok "b-1 リモートに drill/ の枝ができていない" || ng "b-1 リモートに drill/ の枝ができた"
push_expect "b-2 drill/ の枝を別名(feature/x)へ push → 拒否(ローカル側の枝名で止まる)" reject origin drill/2026-10-20-albu:refs/heads/feature/x
g checkout -q main
push_expect "b-3 普通の枝をリモートの drill/ 名へ push → 拒否(リモート側の枝名で止まる)" reject origin main:refs/heads/drill/x
g branch -q -D drill/2026-10-20-albu

echo "## (c) 普通のコミット・枝・タグは通る"
commit "普通の変更"
push_expect "c-1 普通のコミットを main へ → 通る" ok origin main
[ "$(remote_sha main)" = "$(g rev-parse HEAD)" ] && ok "c-1 リモートの main が進んだ" || ng "c-1 リモートの main が進んでいない"
g checkout -q -b feature/ordinary; commit "枝の変更"
push_expect "c-2 普通の枝(feature/)→ 通る" ok -u origin feature/ordinary
g checkout -q main; g branch -q -D feature/ordinary
push_expect "c-3 リモートの枝の削除 → 通る(送るコミットが無い)" ok origin --delete feature/ordinary
[ "$(remote_sha feature/ordinary)" = none ] && ok "c-3 リモートの枝が消えた" || ng "c-3 リモートの枝が残っている"
g tag v1.0.0-test
push_expect "c-4 タグ → 通る" ok origin v1.0.0-test
g checkout -q -b drilling/not-a-drill; commit "drill/ で始まらない枝"
push_expect "c-5 drilling/ は drill/ ではないので通る(前方一致の境界)" ok -u origin drilling/not-a-drill
g checkout -q main; g branch -q -D drilling/not-a-drill
commit "件名に seeded-defect と書くだけ(角括弧なし)"
push_expect "c-6 角括弧のない seeded-defect は通る(マーカーは [seeded-defect] だけ)" ok origin main

echo "## (d) 既存フックの連結(pre-push.local)"
printf '#!/bin/sh\necho "local-hook: 止める" >&2\nexit 1\n' > "$WORK/.git/hooks/pre-push.local"
chmod +x "$WORK/.git/hooks/pre-push.local"
commit "連結の確認 1"
if g push origin main >"$LOG" 2>&1; then ng "d-1 pre-push.local が非 0 → push が止まる" "通ってしまった"
elif grep -q 'local-hook' "$LOG" && ! grep -q "$REJECT_TEXT" "$LOG"; then ok "d-1 pre-push.local が非 0 → push が止まる(drill-guard は通過し、止めたのは local)"
else ng "d-1 pre-push.local が非 0 → push が止まる" "理由文が想定と違う: $(tail -3 "$LOG" | tr '\n' ' ')"; fi
printf '#!/bin/sh\ncat >/dev/null\nexit 0\n' > "$WORK/.git/hooks/pre-push.local"
push_expect "d-2 pre-push.local が 0 → 通る" ok origin main
commit "[seeded-defect] drill 1 #4"
push_expect "d-3 local が 0 でもマーカーがあれば拒否(連結の前に止まる)" reject origin main
g reset -q --hard HEAD~1
rm -f "$WORK/.git/hooks/pre-push.local"

echo
echo "結果: PASS=$PASS FAIL=$FAIL  (フック: $HOOK)"
[ "$FAIL" -eq 0 ]
