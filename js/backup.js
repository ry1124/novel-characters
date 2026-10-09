// バックアップと復元: 人物・出来事を1つのファイル(JSON)に書き出す/読み込む
const Backup = (() => {
  const FORMAT = 'JinbutsurokuBackup';

  async function build() {
    const [people, events] = await Promise.all([DB.getAllPeople(), DB.getAllEvents()]);
    return {
      format: FORMAT,
      version: 2,
      appVersion: typeof APP_VERSION !== 'undefined' ? APP_VERSION : '',
      exportedAt: new Date().toISOString(),
      people, events,
    };
  }

  // 書き出し: iPhoneでは共有シート(「ファイルに保存」など)を、それが無い環境では、ダウンロードを使う
  async function exportFile() {
    const data = await build();
    const json = JSON.stringify(data);
    const stamp = new Date().toISOString().slice(0, 10);
    const file = new File([json], `人物録-バックアップ-${stamp}.json`, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '人物録のバックアップ' });
        return { ok: true, people: data.people.length, events: data.events.length };
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return { ok: false, cancelled: true }; // 共有シートを閉じただけ
      console.error('共有に失敗。ダウンロードに切り替えます:', err);
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { ok: true, people: data.people.length, events: data.events.length };
  }

  function parse(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('ファイルを読めませんでした(バックアップのファイルではありません)'); }
    if (!data || data.format !== FORMAT || !Array.isArray(data.people) || !Array.isArray(data.events)) {
      throw new Error('人物録のバックアップファイルではありません');
    }
    return data;
  }

  // 復元: 既存データはすべて削除し、バックアップの内容に完全に置き換える
  async function restore(data) {
    const [oldPeople, oldEvents] = await Promise.all([DB.getAllPeople(), DB.getAllEvents()]);
    for (const e of oldEvents) await DB.deleteEvent(e.id);
    for (const p of oldPeople) await DB.deletePerson(p.id);

    for (const person of data.people) {
      const { id, eraId, ...rest } = person; // 旧バックアップのeraIdは捨てる
      await DB.addPerson({ ...rest, id });
    }
    for (const event of data.events) {
      const { id, ...rest } = event;
      await DB.addEvent({ ...rest, id });
    }
    return { people: data.people.length, events: data.events.length };
  }

  return { build, exportFile, parse, restore };
})();
