'use strict';

const fs = require('fs');
const path = require('path');

const PKG = 'fishdom-importer';
const STATIC = path.join(__dirname, '..', '..', 'static');
const DEFAULT_FOLDER = 'F:\\AssetFish\\Graphics\\Graphics\\FishdomFish';

exports.template = fs.readFileSync(path.join(STATIC, 'template', 'default.html'), 'utf8');
exports.style = fs.readFileSync(path.join(STATIC, 'style', 'default.css'), 'utf8');

exports.$ = {
    blender: '#blender',
    detect: '#detect',
    folder: '#folder',
    reloadFish: '#reloadFish',
    filter: '#filter',
    gridInfo: '#gridInfo',
    grid: '#grid',
    fishHint: '#fishHint',
    fishWarn: '#fishWarn',
    preview: '#preview',
    previewMsg: '#previewMsg',
    rerender: '#rerender',
    autoScale: '#autoScale',
    sizeHint: '#sizeHint',
    outName: '#outName',
    scale: '#scale',
    slot: '#slot',
    reloadSlots: '#reloadSlots',
    slotHint: '#slotHint',
    replace: '#replace',
    save: '#save',
    run: '#run',
    fixSlot: '#fixSlot',
    status: '#status',
    log: '#log',
};

let fishList = [];
let selected = ''; // tên cá đang chọn
const previews = new Map(); // fbx -> Promise<{ ok, image, size | error }>, dùng chung cho lưới và ảnh lớn
let gridGen = 0; // tăng mỗi lần dựng lại lưới để dừng hàng đợi render cũ
const RENDER_WORKERS = 2; // số Blender chạy song song khi render ảnh thu nhỏ
let slotData = null;
let modelSize = null; // kích thước gốc [x, y, z] của con đang chọn (từ ảnh xem trước)
const TARGET_SIZE = 8000; // cạnh dài nhất của cá mẫu trong project ~6000-9000

function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function loadPrefs() {
    try {
        return JSON.parse(localStorage.getItem(PKG) || '{}');
    } catch (e) {
        return {};
    }
}

function savePrefs(prefs) {
    try {
        localStorage.setItem(PKG, JSON.stringify(prefs));
    } catch (e) {
        /* convenience only */
    }
}

exports.methods = {
    persist() {
        savePrefs({
            blender: this.$.blender.value.trim(),
            folder: this.$.folder.value.trim(),
            scale: Number(this.$.scale.value) || 45000,
            fish: selected,
            slot: this.$.slot.value,
            replace: !!this.$.replace.value,
            save: !!this.$.save.value,
        });
    },

    async onDetect() {
        const exe = await Editor.Message.request(PKG, 'detect-blender').catch(() => '');
        if (exe) this.$.blender.value = exe;
        this.$.status.textContent = exe ? 'Đã tìm thấy Blender' : 'Không tìm thấy Blender trong Program Files';
        this.persist();
    },

    async loadFish() {
        const keep = selected || loadPrefs().fish;
        const res = await Editor.Message.request(PKG, 'list-fish', this.$.folder.value.trim()).catch(() => null);
        fishList = (res && res.fish) || [];
        selected = fishList.some((f) => f.name === keep) ? keep : (fishList[0] ? fishList[0].name : '');
        if (!this.$.outName.value && res) this.$.outName.value = res.nextName;
        this.renderGrid();
        this.updateFishHint();
    },

    /** Ảnh xem trước của 1 con, render 1 lần rồi dùng lại (main.js còn cache ra đĩa). */
    requestPreview(f, force) {
        if (force || !previews.has(f.fbx)) {
            previews.set(f.fbx, Editor.Message.request(PKG, 'preview-fish', {
                blender: this.$.blender.value.trim(), name: f.name, fbx: f.fbx, png: f.png, force: !!force,
            }).catch((e) => ({ ok: false, error: e.message })));
        }
        return previews.get(f.fbx);
    },

    /** Lưới ảnh thu nhỏ của mọi con trong thư mục; ảnh chưa có được render dần ở nền. */
    renderGrid() {
        const gen = ++gridGen;
        this.$.grid.innerHTML = fishList.length
            ? fishList.map((f, i) => '<div class="card' + (f.name === selected ? ' selected' : '') + (f.warning ? ' warn-card' : '')
                + '" data-i="' + i + '" title="' + escapeHtml(f.name + (f.warning ? ' - ⚠ ' + f.warning : '')) + '">'
                + '<div class="thumb">…</div><div class="name">' + escapeHtml(f.name) + '</div></div>').join('')
            : '<span class="hint">(không có file .fbx)</span>';
        this.applyFilter();
        const sel = this.$.grid.querySelector('.card.selected');
        if (sel) sel.scrollIntoView({ block: 'nearest' });

        // con đang chọn render trước, sau đó theo thứ tự trong lưới
        const queue = fishList.map((f, i) => i).sort((a, b) => (fishList[b].name === selected) - (fishList[a].name === selected));
        let done = 0;
        const info = () => {
            if (gen === gridGen) this.$.gridInfo.textContent = fishList.length + ' con' + (done < fishList.length ? ' · render ' + done + '/' + fishList.length : '');
        };
        info();
        const worker = async () => {
            while (queue.length && gen === gridGen) {
                const i = queue.shift();
                const res = await this.requestPreview(fishList[i], false);
                if (gen !== gridGen) return;
                done++;
                this.setThumb(i, res);
                info();
            }
        };
        for (let k = 0; k < RENDER_WORKERS; k++) worker();
    },

    setThumb(i, res) {
        const box = this.$.grid.querySelector('.card[data-i="' + i + '"] .thumb');
        if (!box) return;
        box.innerHTML = res.ok ? '<img src="' + res.image + '">' : 'Lỗi render';
        if (!res.ok) box.title = res.error || '';
    },

    applyFilter() {
        const q = (this.$.filter.value || '').trim().toLowerCase();
        for (const card of this.$.grid.querySelectorAll('.card')) {
            const f = fishList[Number(card.dataset.i)];
            card.classList.toggle('hidden', !!q && !f.name.toLowerCase().includes(q));
        }
    },

    onGridClick(e) {
        const card = e.target.closest && e.target.closest('.card');
        if (!card) return;
        const f = fishList[Number(card.dataset.i)];
        if (!f || f.name === selected) return;
        selected = f.name;
        for (const c of this.$.grid.querySelectorAll('.card.selected')) c.classList.remove('selected');
        card.classList.add('selected');
        this.updateFishHint();
        this.persist();
    },

    updateFishHint() {
        const f = fishList.find((x) => x.name === selected);
        const parts = [];
        if (f && f.png) parts.push('Texture: ' + path.basename(f.png));
        if (f && f.unity) parts.push('Animator: ' + f.unity.animator.replace('ProceduralAnimator', '') + ' (' + Object.keys(f.unity.params).length + ' tham số từ ' + path.basename(f.unity.prefab) + ')');
        this.$.fishHint.textContent = parts.join('  ·  ');
        this.$.fishWarn.textContent = f && f.warning ? '⚠ ' + f.warning : '';
        this.$.fishWarn.classList.toggle('hidden', !(f && f.warning));
        this.loadPreview(false);
    },

    /** Ảnh con cá sau khi chuyển (Blender render, cache theo tên); force = render lại. */
    async loadPreview(force) {
        const f = fishList.find((x) => x.name === selected);
        const token = (this.previewToken = (this.previewToken || 0) + 1);
        modelSize = null;
        this.updateSizeHint();
        this.$.preview.classList.add('hidden');
        this.$.previewMsg.classList.remove('hidden');
        if (!f) {
            this.$.previewMsg.textContent = 'Chọn cá để xem trước';
            return;
        }
        this.$.previewMsg.textContent = 'Đang render ' + f.name + '...';
        const res = await this.requestPreview(f, force);
        if (force) this.setThumb(fishList.indexOf(f), res);
        if (token !== this.previewToken) return; // đã chọn con khác trong lúc render
        if (!res.ok) {
            this.$.previewMsg.textContent = 'Không render được: ' + res.error;
            return;
        }
        this.$.preview.src = res.image;
        this.$.preview.classList.remove('hidden');
        this.$.previewMsg.classList.add('hidden');
        modelSize = res.size || null;
        this.updateSizeHint();
    },

    updateSizeHint() {
        if (!modelSize) {
            this.$.sizeHint.textContent = '';
            return;
        }
        const scale = Number(this.$.scale.value) || 0;
        const longest = Math.max(...modelSize) * scale;
        const tooSmall = longest < TARGET_SIZE * 0.6;
        const tooBig = longest > TARGET_SIZE * 1.4;
        this.$.sizeHint.textContent = 'Cạnh dài nhất sau scale ≈ ' + Math.round(longest)
            + ' (cá mẫu ~6000–9000)' + (tooSmall ? ' - nhỏ quá, bấm Tự tính' : tooBig ? ' - to quá, bấm Tự tính' : '');
    },

    onAutoScale() {
        if (!modelSize) return;
        const raw = TARGET_SIZE / Math.max(...modelSize);
        const step = raw >= 10000 ? 1000 : raw >= 1000 ? 100 : 1;
        this.$.scale.value = Math.max(1, Math.round(raw / step) * step);
        this.updateSizeHint();
        this.persist();
    },

    async loadSlots() {
        const keep = this.$.slot.value || loadPrefs().slot;
        slotData = await Editor.Message.request(PKG, 'list-slots').catch(() => null);
        const slots = (slotData && slotData.slots) || [];
        this.$.slot.innerHTML = '<option value="">(không đặt vào scene)</option>'
            + slots.map((s) => '<option value="' + escapeHtml(s.uuid) + '">' + s.index + ' · ' + escapeHtml(s.name)
                + (s.children.length ? '  [' + escapeHtml(s.children.join(', ')) + ']' : '  (trống)') + '</option>').join('');
        this.$.slot.value = slots.some((s) => s.uuid === keep) ? keep : '';
        this.updateSlotHint();
    },

    updateSlotHint() {
        if (!slotData || !slotData.fishRoot) {
            this.$.slotHint.textContent = 'Không thấy node Fish (chứa SK_Fish*) - mở PlayScene rồi bấm ↻.';
            return;
        }
        const s = slotData.slots.find((x) => x.uuid === this.$.slot.value);
        if (!s) {
            this.$.slotHint.textContent = 'Chỉ import GLB + PNG vào Assets.';
            return;
        }
        const tex = slotData.mats && slotData.mats.textures[s.index];
        this.$.slotHint.textContent = 'Loại cá ' + s.index + ' (room.fish.children[' + s.index + ']). Mats.textures[' + s.index + ']: '
            + (tex ? 'đang có texture, sẽ bị thay' : 'trống');
    },

    async onRun() {
        this.persist();
        const f = fishList.find((x) => x.name === selected);
        if (!f) {
            this.$.status.textContent = 'Chưa chọn cá';
            return;
        }
        this.$.run.disabled = true;
        this.$.status.textContent = 'Đang chạy...';
        this.$.log.classList.remove('hidden', 'error');
        this.$.log.textContent = 'Đang chuyển ' + f.name + ' bằng Blender...';
        const res = await Editor.Message.request(PKG, 'import-fish', {
            blender: this.$.blender.value.trim(),
            fbx: f.fbx,
            png: f.png,
            unity: f.unity || null, // prefab Unity: bake tham số animator vào FishAnimConfig
            outName: this.$.outName.value.trim(),
            scale: Number(this.$.scale.value) || 45000,
            slotUuid: this.$.slot.value,
            replace: !!this.$.replace.value,
            save: !!this.$.save.value,
        }).catch((e) => ({ ok: false, log: ['LỖI: ' + e.message] }));
        this.$.run.disabled = false;
        this.$.log.textContent = res.log.join('\n');
        this.$.log.classList.toggle('error', !res.ok);
        this.$.status.textContent = res.ok ? 'Xong' : 'Lỗi';
        if (res.ok) {
            this.$.outName.value = '';
            await this.loadFish();
            await this.loadSlots();
        }
    },

    /** Chuẩn hoá model đang có trong slot đã chọn (vd kéo prefab vào tay) mà không import lại. */
    async onFixSlot() {
        if (!this.$.slot.value) {
            this.$.status.textContent = 'Chưa chọn slot';
            return;
        }
        this.$.fixSlot.disabled = true;
        this.$.log.classList.remove('hidden', 'error');
        const res = await Editor.Message.request(PKG, 'fix-slot', {
            slotUuid: this.$.slot.value,
            save: !!this.$.save.value,
        }).catch((e) => ({ ok: false, log: ['LỖI: ' + e.message] }));
        this.$.fixSlot.disabled = false;
        this.$.log.textContent = res.log.join('\n');
        this.$.log.classList.toggle('error', !res.ok);
        this.$.status.textContent = res.ok ? 'Đã sửa slot' : 'Lỗi';
        await this.loadSlots();
    },
};

exports.ready = async function () {
    const prefs = loadPrefs();
    this.$.blender.value = prefs.blender || '';
    this.$.folder.value = prefs.folder || DEFAULT_FOLDER;
    this.$.scale.value = prefs.scale || 45000;
    this.$.replace.value = prefs.replace !== undefined ? prefs.replace : true;
    this.$.save.value = prefs.save !== undefined ? prefs.save : true;
    if (!this.$.blender.value) await this.onDetect();

    await this.loadFish();
    await this.loadSlots();

    this.$.detect.addEventListener('confirm', this.onDetect.bind(this));
    this.$.reloadFish.addEventListener('confirm', this.loadFish.bind(this));
    this.$.reloadSlots.addEventListener('confirm', this.loadSlots.bind(this));
    this.$.rerender.addEventListener('confirm', () => this.loadPreview(true));
    this.$.run.addEventListener('confirm', this.onRun.bind(this));
    this.$.fixSlot.addEventListener('confirm', this.onFixSlot.bind(this));
    this.$.folder.addEventListener('change', () => { this.persist(); this.loadFish(); });
    this.$.grid.addEventListener('click', this.onGridClick.bind(this));
    this.$.filter.addEventListener('change', this.applyFilter.bind(this));
    this.$.slot.addEventListener('change', () => { this.updateSlotHint(); this.persist(); });
    this.$.blender.addEventListener('change', this.persist.bind(this));
    this.$.scale.addEventListener('change', () => { this.updateSizeHint(); this.persist(); });
    this.$.autoScale.addEventListener('confirm', this.onAutoScale.bind(this));
    this.$.replace.addEventListener('change', this.persist.bind(this));
    this.$.save.addEventListener('change', this.persist.bind(this));
};

exports.close = function () {};
