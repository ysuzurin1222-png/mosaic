/* ==========================================================================
   ひとコマ — 通知の文面データ
   ここはデータだけの場所です。ロジックには触れずに増やせます。

   使える差し込み語
     {target} … 「筋トレ」または「未記録の目標が2つ」
     {tile}   … 今日が何枚目のタイルか        （目標が1つのときだけ）
     {total}  … タイルの総数                  （同上）
     {left}   … 残っているタイルの数          （同上）
     {streak} … 連続している日数              （同上）
     {pct}    … いまの完成度（%）             （同上）

   状況の種類
     normal … ふつうの未記録
     streak … 3日以上つながっている
     broke  … 昨日を落としている
     near   … 完成まであと少し（残り5枚以下）
   目標が2つ以上のときは many の normal だけを使います。
   ========================================================================== */

window.LATENT_MESSAGES = {

  toneNames: { plain: '淡々と', kind: 'やさしい', strict: '厳しめ' },
  slotNames: { morning: '朝', evening: '夕方', night: '夜' },

  lines: {

    /* ======================= 淡々と ======================= */
    plain: {
      morning: {
        one: {
          normal: [
            { title: '{tile}枚目', body: '{target}・未記録' },
            { title: '今日のタイル', body: '{target}は{total}枚中{tile}枚目です' },
          ],
          streak: [
            { title: '{streak}日つながっています', body: '{target}・今日は{tile}枚目' },
          ],
          broke: [
            { title: '昨日は開きませんでした', body: '{target}・今日は{tile}枚目' },
          ],
          near: [
            { title: 'あと{left}枚', body: '{target}・完成度{pct}%' },
          ],
        },
        many: {
          normal: [
            { title: '今日ぶんが残っています', body: '{target}' },
            { title: '未記録', body: '{target}あります' },
          ],
        },
      },
      evening: {
        one: {
          normal: [
            { title: 'まだ間に合います', body: '{target}・{tile}枚目が未記録' },
            { title: '{tile}枚目', body: '{target}・今日はまだ開いていません' },
          ],
          streak: [
            { title: '{streak}日目', body: '{target}・今日ぶんが残っています' },
          ],
          broke: [
            { title: '2日続けて空きます', body: '{target}・{tile}枚目が未記録' },
          ],
          near: [
            { title: '完成まであと{left}枚', body: '{target}・今日ぶんが未記録' },
          ],
        },
        many: {
          normal: [
            { title: 'まだ間に合います', body: '{target}' },
          ],
        },
      },
      night: {
        one: {
          normal: [
            { title: '今日が終わります', body: '{target}・{tile}枚目は未記録のままです' },
            { title: '最後の確認', body: '{target}・記録がありません' },
          ],
          streak: [
            { title: '{streak}日で止まります', body: '{target}・今日ぶんが未記録' },
          ],
          broke: [
            { title: '穴が2つ並びます', body: '{target}・{tile}枚目が未記録' },
          ],
          near: [
            { title: 'あと{left}枚で完成', body: '{target}・今日ぶんが未記録' },
          ],
        },
        many: {
          normal: [
            { title: '今日が終わります', body: '{target}' },
          ],
        },
      },
    },

    /* ======================= やさしい ======================= */
    kind: {
      morning: {
        one: {
          normal: [
            { title: 'おはようございます', body: '今日は{target}の{tile}枚目です' },
            { title: '今日も1枚', body: '{target}、いつでも大丈夫です' },
          ],
          streak: [
            { title: '{streak}日続いています', body: '{target}、いい流れです' },
          ],
          broke: [
            { title: '今日から始めましょう', body: '{target}、昨日のことは気にしなくて大丈夫です' },
          ],
          near: [
            { title: 'あと{left}枚です', body: '{target}、ゴールが見えてきました' },
          ],
        },
        many: {
          normal: [
            { title: 'おはようございます', body: '{target}。ひとつずつで大丈夫です' },
          ],
        },
      },
      evening: {
        one: {
          normal: [
            { title: 'まだ今日は終わっていません', body: '{target}、{tile}枚目が待っています' },
            { title: 'ひと呼吸おいて', body: '{target}、少しだけでも大丈夫です' },
          ],
          streak: [
            { title: '{streak}日目です', body: '{target}、今日も残しておきましょう' },
          ],
          broke: [
            { title: '今日は開けられます', body: '{target}、まだ時間があります' },
          ],
          near: [
            { title: 'あと{left}枚', body: '{target}、もう少しで写真がそろいます' },
          ],
        },
        many: {
          normal: [
            { title: 'まだ間に合います', body: '{target}。できるものから大丈夫です' },
          ],
        },
      },
      night: {
        one: {
          normal: [
            { title: '今日はどうでしたか', body: '{target}、{tile}枚目がまだ開いていません' },
            { title: 'おつかれさまです', body: '{target}、記録だけしておきませんか' },
          ],
          streak: [
            { title: '{streak}日、続いています', body: '{target}、今日もここまで来ました' },
          ],
          broke: [
            { title: 'まだ間に合います', body: '{target}、今日ぶんを残しておきましょう' },
          ],
          near: [
            { title: '完成まであと{left}枚', body: '{target}、ここまで来ました' },
          ],
        },
        many: {
          normal: [
            { title: 'おつかれさまです', body: '{target}。今日のぶんだけ残しておきませんか' },
          ],
        },
      },
    },

    /* ======================= 厳しめ ======================= */
    strict: {
      morning: {
        one: {
          normal: [
            { title: '{tile}枚目', body: '{target}。今日開かなければ、そこは永久に穴です' },
            { title: '今日のぶんは今日だけ', body: '{target}・{total}枚中{tile}枚目' },
          ],
          streak: [
            { title: '{streak}日積み上げました', body: '{target}。捨てるのは今日1日で足ります' },
          ],
          broke: [
            { title: '昨日は落としました', body: '{target}。今日も落とせば、並んだ穴になります' },
          ],
          near: [
            { title: 'あと{left}枚', body: '{target}。ここで気を抜く人が一番多い' },
          ],
        },
        many: {
          normal: [
            { title: '{target}', body: '全部あなたが決めたことです' },
          ],
        },
      },
      evening: {
        one: {
          normal: [
            { title: 'まだ開いていません', body: '{target}・{tile}枚目。言い訳を考える時間はありました' },
            { title: '残り時間は減っています', body: '{target}・{tile}枚目が未記録' },
          ],
          streak: [
            { title: '{streak}日が今日で終わります', body: '{target}。もったいないと思うなら動いてください' },
          ],
          broke: [
            { title: '2日目です', body: '{target}。ここで止めないと、ただの習慣になります' },
          ],
          near: [
            { title: 'あと{left}枚', body: '{target}。ここまで来て未完成で終わるつもりですか' },
          ],
        },
        many: {
          normal: [
            { title: '{target}', body: 'まだ間に合う時間です' },
          ],
        },
      },
      night: {
        one: {
          normal: [
            { title: '今日は開きませんでした', body: '{target}・{tile}枚目。この穴は消えません' },
            { title: '最後の機会です', body: '{target}。明日この日は戻ってきません' },
          ],
          streak: [
            { title: '{streak}日、ここで終わりですか', body: '{target}。積み上げは一晩で消えます' },
          ],
          broke: [
            { title: '穴が2つ並びます', body: '{target}。写真を見たとき、そこだけ目につきます' },
          ],
          near: [
            { title: '完成まであと{left}枚', body: '{target}。今日の1枚を惜しんで、全部を惜しむのですか' },
          ],
        },
        many: {
          normal: [
            { title: '{target}', body: '今日はもう終わります' },
          ],
        },
      },
    },
  },
};
