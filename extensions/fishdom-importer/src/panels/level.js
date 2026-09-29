'use strict';

const fs = require('fs');
const path = require('path');

const PKG = 'fishdom-importer';
const PREFS = PKG + '.level';
const STATIC = path.join(__dirname, '..', '..', 'static');
const RENDER_WORKERS = 2;

exports.template = fs.readFileSync(path.join(STATIC, 'template', 'level.html'), 'utf8');
exports.style = fs.readFileSync(path.join(STATIC, 'style', 'default.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(STATIC, 'style', 'level.css'), 'utf8');

exports.$ = {
    reload: '#reload',
    summary: '#summary',
    selPlaying: '#selPlaying',
    selNone: '#selNone',
    gridInfo: '#gridInfo',
    grid: '#grid',
    selection: '#selection',
    regen: '#regen',
    clearUnused: '#clearUnused',
    save: '#save',
    blender: '#blender',
    unityRoot: '#unityRoot',
    apply: '#apply',
    status: '#status',
    log: '#log',
};

let fishList = [];
let picked = new Set();     // index loại cá được chọn
const previews = new Map(); // file|mtime -> Promise<preview>
let gridGen = 0;

function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function loadPrefs(key) {
    try {
        return JSON.parse(localStorage.getItem(key) || '{}');
    } catch (e) {
        return {};
    }
}

function savePrefs(prefs) {
    try {
        localStorage.setItem(PREFS, JSON.stringify(prefs));
    } catch (e) {
        /* convenience only */
    }
}

exports.methods = {
    persist() {
        savePrefs({
            blender: this.$.blender.value.trim(),
            unityRoot: this.$.unityRoot.value.trim(),
            regen: !!this.$.regen.value,
            clearUnused: !!this.$.clearUnused.value,
            save: !!this.$.save.value,
        });
    },

    async load() {
        this.$.status.textContent = 'Đang đọc...';
        const res = await Editor.Message.request(PKG, 'list-project-fish', this.$.unityRoot.value.trim()).catch((e) => ({ error: e.message }));
        if (!res || res.error || !res.ok) {
            fishList = [];
            this.$.grid.innerHTML = '<span class="hint">Không đọc được scene - mở PlayScene rồi bấm ↻. ' + escapeHtml((res && res.error) || '') + '</span>';
            this.$.status.textContent = '';
            return;
        }
        fishList = res.fish;
        picked = new Set(res.fishTypes.filter((i) => fishList.some((f) => f.index === i)));
        this.$.summary.textContent = '· ' + fishList.length + ' model · đang chơi ' + res.fishTypes.length + ' loại [' + res.fishTypes.join(', ')
            + '] · ' + res.bubbles + ' bubble / ' + res.bubbleFish + ' cá';
        this.levelInfo = res;
        this.$.status.textContent = '';
        this.renderGrid();
    },

    requestPreview(f, force) {
        const key = f.file + '|' + f.mtime + '|' + f.png;
        if (force || !previews.has(key)) {
            previews.set(key, Editor.Message.request(PKG, 'preview-project-fish', {
                blender: this.$.blender.value.trim(), name: f.name, file: f.file, png: f.png, mtime: f.mtime, force: !!force,
            }).catch((e) => ({ ok: false, error: e.message })));
        }
        return previews.get(key);
    },

    cardHtml(f, i) {
        const badges = [];
        if (f.playing) badges.push('<span class="badge">đang chơi · ' + f.usage + ' con</span>');
        else if (f.usage) badges.push('<span class="badge warn">' + f.usage + ' con trong BubbleData</span>');
        if (!f.inScene && f.slotModel) badges.push('<span class="badge warn">slot đang là ' + escapeHtml(f.slotModel) + '</span>');
        if (!f.png) badges.push('<span class="badge warn">thiếu texture</span>');
        if (f.unity) badges.push('<span class="badge" title="' + escapeHtml(f.unity.prefab) + '">' + escapeHtml(f.unity.animator.replace('ProceduralAnimator', '')) + ' · ' + escapeHtml(f.unityName) + '</span>');
        return '<div class="card' + (picked.has(f.index) ? ' picked' : '') + '" data-i="' + i + '" title="' + escapeHtml(f.url + '\nmodel: ' + f.model + (f.png ? '\ntexture: ' + path.basename(f.png) : '')) + '">'
            + '<span class="check">' + (picked.has(f.index) ? '✔' : '') + '</span>'
            + '<div class="thumb">…</div>'
            + '<div class="name">' + escapeHtml(f.name) + '</div>'
            + '<div class="meta">loại ' + f.index + ' · ' + escapeHtml(f.model || '?') + (f.inScene ? ' · có trong slot' : '') + '<br>' + badges.join(' ') + '</div>'
            + '</div>';
    },

    renderGrid() {
        const gen = ++gridGen;
        this.$.grid.innerHTML = fishList.length
            ? fishList.map((f, i) => this.cardHtml(f, i)).join('')
            : '<span class="hint">(không có SK_Fish*.glb trong Meshes/Fishes)</span>';
        this.updateSelection();

        const queue = fishList.map((f, i) => i);
        let done = 0;
        const info = () => {
            if (gen === gridGen) this.$.gridInfo.textContent = done < fishList.length ? 'render ảnh ' + done + '/' + fishList.length : '';
        };
        info();
        const worker = async () => {
            while (queue.length && gen === gridGen) {
                const i = queue.shift();
                const res = await this.requestPreview(fishList[i], false);
                if (gen !== gridGen) return;
                done++;
                const box = this.$.grid.querySelector('.card[data-i="' + i + '"] .thumb');
                if (box) box.innerHTML = res.ok ? '<img src="' + res.image + '">' : 'Lỗi render';
                info();
            }
        };
        for (let k = 0; k < RENDER_WORKERS; k++) worker();
    },

    updateSelection() {
        const list = Array.from(picked).sort((a, b) => a - b);
        const info = this.levelInfo;
        const groups = info ? Math.floor(info.bubbleFish / 3) : 0;
        let text = 'Chọn ' + list.length + ' loại: [' + list.join(', ') + ']';
        if (info && list.length) {
            const per = Math.floor(groups / list.length);
            const extra = groups % list.length;
            text += ' · ' + groups + ' hộp (' + info.bubbleFish + ' cá trong ' + info.bubbles + ' bubble) → mỗi loại ' + per + (extra ? '–' + (per + 1) : '') + ' hộp';
            if (list.length > groups) text += ' ⚠ nhiều loại hơn số hộp, có loại sẽ không xuất hiện';
        }
        this.$.selection.textContent = text;
    },

    onGridClick(e) {
        const card = e.target.closest && e.target.closest('.card');
        if (!card) return;
        const i = Number(card.dataset.i);
        const f = fishList[i];
        if (!f) return;
        if (picked.has(f.index)) picked.delete(f.index); else picked.add(f.index);
        card.classList.toggle('picked', picked.has(f.index));
        card.querySelector('.check').textContent = picked.has(f.index) ? '✔' : '';
        this.updateSelection();
    },

    onSelPlaying() {
        picked = new Set(fishList.filter((f) => f.playing).map((f) => f.index));
        this.renderGrid();
    },

    onSelNone() {
        picked = new Set();
        this.renderGrid();
    },

    async onApply() {
        this.persist();
        const selected = Array.from(picked).sort((a, b) => a - b);
        if (!selected.length) {
            this.$.status.textContent = 'Chưa chọn con nào';
            return;
        }
        this.$.apply.disabled = true;
        this.$.status.textContent = 'Đang áp dụng...';
        this.$.log.classList.remove('hidden', 'error');
        this.$.log.textContent = 'Đang áp dụng ' + selected.length + ' loại cá...';
        const res = await Editor.Message.request(PKG, 'apply-level', {
            selected,
            unityRoot: this.$.unityRoot.value.trim(),
            regen: !!this.$.regen.value,
            clearUnused: !!this.$.clearUnused.value,
            save: !!this.$.save.value,
        }).catch((e) => ({ ok: false, log: ['LỖI: ' + e.message] }));
        this.$.apply.disabled = false;
        this.$.log.textContent = res.log.join('\n');
        this.$.log.classList.toggle('error', !res.ok);
        this.$.status.textContent = res.ok ? 'Xong' : 'Lỗi';
        if (res.ok) setTimeout(() => this.load(), 1500);
    },
};

exports.ready = async function () {
    const prefs = loadPrefs(PREFS);
    const importerPrefs = loadPrefs(PKG);
    this.$.blender.value = prefs.blender || importerPrefs.blender || '';
    this.$.unityRoot.value = prefs.unityRoot !== undefined ? prefs.unityRoot : 'F:\\AssetFish\\FishSort-new-item';
    this.$.regen.value = prefs.regen !== undefined ? prefs.regen : true;
    this.$.clearUnused.value = prefs.clearUnused !== undefined ? prefs.clearUnused : true;
    this.$.save.value = prefs.save !== undefined ? prefs.save : true;
    if (!this.$.blender.value) this.$.blender.value = await Editor.Message.request(PKG, 'detect-blender').catch(() => '');

    this.$.reload.addEventListener('confirm', this.load.bind(this));
    this.$.selPlaying.addEventListener('confirm', this.onSelPlaying.bind(this));
    this.$.selNone.addEventListener('confirm', this.onSelNone.bind(this));
    this.$.apply.addEventListener('confirm', this.onApply.bind(this));
    this.$.grid.addEventListener('click', this.onGridClick.bind(this));
    for (const k of ['regen', 'clearUnused', 'save', 'blender']) this.$[k].addEventListener('change', this.persist.bind(this));
    this.$.unityRoot.addEventListener('change', () => { this.persist(); this.load(); });

    await this.load();
};

exports.close = function () {};
