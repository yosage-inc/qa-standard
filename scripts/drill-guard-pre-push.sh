#!/bin/sh
# drill-guard-pre-push.sh — 欠陥埋め込み訓練(seeded-defect drill)の枝・コミットを push させない pre-push フック
#
# 何をするか(~/qa-standard/docs/qa-profile-standard.md §5 / docs/seeded-defect-drill.md §13):
#   push しようとしている参照のうち、次のどちらかに当たるものがあれば push 全体を拒否し、理由を出す。
#     1. 枝名が drill/ で始まる(ローカル側・リモート側のどちらでも)
#     2. 新しく送るコミットのメッセージ(件名+本文)に [seeded-defect] がある
#   訓練の枝はわざと壊したコードなので、本番にも共有環境にも出してはいけない。
#
# 導入: 対象リポジトリの hooks ディレクトリに pre-push という名前でコピーして実行権限を付ける。
#   hooks の場所は必ず絶対パスで取る(--path-format=absolute、git 2.31+)。これが無いと
#   `git -C <repo> rev-parse --git-path hooks` は cwd 相対の ".git/hooks" を返し、<repo> 以外の
#   ディレクトリから実行すると別の場所(cwd が別リポジトリならそのリポジトリの hooks)に入る。
#   HOOKS="$(git -C <repo> rev-parse --path-format=absolute --git-path hooks)"
#   cp ~/qa-standard/scripts/drill-guard-pre-push.sh "$HOOKS/pre-push" && chmod +x "$HOOKS/pre-push"
# 既存の pre-push があるとき: それを同じディレクトリの pre-push.local に改名すると、このフックが
#   通過後に同じ引数・同じ標準入力で呼ぶ(どちらかが非 0 なら push は止まる)。
#
# 自己テスト: ~/qa-standard/scripts/drill-guard.test.sh(使い捨てリポジトリで拒否・通過を実測)
# 依存: git と POSIX sh だけ(0 円)。macOS 標準の /bin/sh(bash 3.2)で動く書き方にしている。
#
# git から渡されるもの: 引数 $1=リモート名 $2=リモート URL、
#   標準入力に 1 行 1 参照で "<local ref> <local sha> <remote ref> <remote sha>"(sha が全部 0 = 無い)。

MARKER='[seeded-defect]'
BRANCH_PREFIX='refs/heads/drill/'
remote_name="${1:-origin}"

# 標準入力は 1 回しか読めないので全部取っておく(連結する既存フックにも同じものを渡す)
input=$(cat)
feed_input() { if [ -n "$input" ]; then printf '%s\n' "$input"; fi; }

is_zero_sha() {
  case "$1" in
    '') return 0 ;;
    *[!0]*) return 1 ;;
    *) return 0 ;;
  esac
}

# 拒否理由を集める(関数にして呼ぶ。古い /bin/sh は $( ) の中の case を正しく読めないため)
collect_reasons() {
  feed_input | while read -r lref lsha rref rsha; do
    [ -z "$lref" ] && continue
    # 削除(ローカル側が無い)は送るコミットが無いので対象外
    if is_zero_sha "$lsha"; then continue; fi

    case "$lref" in
      "$BRANCH_PREFIX"*) echo "枝名が drill/ で始まる(ローカル): $lref" ;;
    esac
    case "$rref" in
      "$BRANCH_PREFIX"*) echo "枝名が drill/ で始まる(リモート先): $rref" ;;
    esac

    # 新しく送るコミットの範囲を決める。リモート側の sha が無い/手元に無いときは
    # 「リモートのどの枝にも入っていないコミット」を範囲にする(広め=安全側)
    if is_zero_sha "$rsha" || ! git cat-file -e "$rsha^{commit}" 2>/dev/null; then
      hits=$(git log --fixed-strings --grep="$MARKER" --format='%h %s' "$lsha" --not --remotes="$remote_name" -- 2>/dev/null)
    else
      hits=$(git log --fixed-strings --grep="$MARKER" --format='%h %s' "$rsha..$lsha" -- 2>/dev/null)
    fi
    if [ -n "$hits" ]; then
      printf '%s\n' "$hits" | while read -r h; do
        echo "コミットのメッセージに $MARKER がある: $h ($lref → $rref)"
      done
    fi
  done
}
reasons=$(collect_reasons)

if [ -n "$reasons" ]; then
  {
    echo "drill-guard: push を拒否しました(欠陥埋め込み訓練の守り)"
    echo "  理由:"
    printf '%s\n' "$reasons" | sed 's/^/    - /'
    echo "  訓練の枝・コミットは本番にも共有環境にも出さない決まり(~/qa-standard/docs/qa-profile-standard.md §5)。"
    echo "  対処: 訓練が終わったら枝を消す(docs/seeded-defect-drill.md「後始末」)。"
    echo "        出したい変更に訓練のコミットが混ざっているなら、rebase で取り除いてから push する。"
    echo "  このフックの元: ~/qa-standard/scripts/drill-guard-pre-push.sh"
  } >&2
  exit 1
fi

# 連結: 同じディレクトリに pre-push.local があれば、同じ引数・同じ標準入力で呼ぶ
local_hook="$(dirname "$0")/pre-push.local"
if [ -x "$local_hook" ]; then
  feed_input | "$local_hook" "$@"
  exit $?
fi

exit 0
