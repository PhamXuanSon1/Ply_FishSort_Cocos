'use strict';
/**
 * Fishdom Fish Importer - quy trình cho 1 con cá:
 *  1. Blender (scripts/convert.py): FBX + PNG -> GLB 1 material, texture nhúng, scale bake vào vertex/xương.
 *  2. Copy GLB vào 8.Models/Meshes/Fishes/<outName>.glb, PNG vào 8.Models/Textures/Fishes/<tên cá>.png, refresh asset-db.
 *  3. Scene: (tuỳ chọn) xoá con cũ của slot SK_FishN, tạo prefab của GLB làm con, xoay để đầu hướng +Z,
 *     canh tâm mesh về gốc slot, để trống material slot 0 (Thing.setMeshMat gán material Fish lúc chạy),
 *     gán Mats.textures[N] = texture PNG, lưu scene.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const unity = require('./unity');

const PKG = 'fishdom-importer';
const MESH_DIR = 'db://assets/8.Models/Meshes/Fishes';
const PREVIEW_VERSION = 2; // 2: góc 3/4 (cá) / chính diện (sinh vật khác), có đèn
const TEX_DIR = 'db://assets/8.Models/Textures/Fishes';

function log(message) {
    console.log('[' + PKG + '] ' + message);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function dbToFs(url) {
    return path.normalize(await Editor.Message.request('asset-db', 'query-path', url));
}

function sceneScript(method, ...args) {
    return Editor.Message.request('scene', 'execute-scene-script', { name: PKG, method, args });
}

function setProp(uuid, prop, dump) {
    return Editor.Message.request('scene', 'set-property', { uuid, path: prop, dump });
}

// ---------------------------------------------------------------- blender

function detectBlender() {
    const base = 'C:\\Program Files\\Blender Foundation';
    const found = [];
    if (fs.existsSync(base)) {
        for (const d of fs.readdirSync(base)) {
            const exe = path.join(base, d, 'blender.exe');
            if (fs.existsSync(exe)) found.push({ exe, version: (d.match(/[\d.]+/) || ['0'])[0] });
        }
    }
    found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    return found.length ? found[0].exe : '';
}

function runBlender(blender, fbx, png, out, scale, scriptName = 'convert.py', extra = []) {
    const script = path.join(__dirname, 'scripts', scriptName);
    const args = ['-b', '--factory-startup', '--python', script, '--', fbx, png || '', out, String(scale), ...extra];
    return new Promise((resolve, reject) => {
        const p = spawn(blender, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { p.kill(); reject(new Error('Blender quá 5 phút, đã dừng')); }, 5 * 60 * 1000);
        p.stdout.on('data', (d) => { stdout += d; });
        p.stderr.on('data', (d) => { stderr += d; });
        p.on('error', (e) => { clearTimeout(timer); reject(e); });
        p.on('close', (code) => {
            clearTimeout(timer);
            const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
            if (!line) {
                const err = (stdout + '\n' + stderr).split(/\r?\n/).filter((l) => /error/i.test(l)).slice(-5).join('\n');
                reject(new Error('Blender không xuất được GLB (exit ' + code + ')\n' + err));
                return;
            }
            resolve(JSON.parse(line.slice(7)));
        });
    });
}

/**
 * Texture của cá: ưu tiên <tên>.png; không có thì lấy ảnh mà FBX tham chiếu (vd harlequin2_fish_color.png).
 * warning khi thiếu ảnh hoặc cá dùng nhiều ảnh (chỉ gộp được 1 texture vào 1 material).
 */
/** Index tên file ảnh (lowercase) -> đường dẫn, trong `dir` và thư mục con (tối đa `depth` cấp). */
function indexImages(dir, depth, out = new Map()) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return out;
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (depth > 0) indexImages(p, depth - 1, out);
        } else if (/\.(png|jpg|jpeg|tga)$/i.test(e.name) && !out.has(e.name.toLowerCase())) {
            out.set(e.name.toLowerCase(), p);
        }
    }
    return out;
}

const imageIndexCache = new Map();

/**
 * Ảnh trong thư mục FBX trước, rồi tới thư mục cha (vd Models/Fish Rig/SK_Fish21.fbx -> Models/Texture/Fish21/T_Fish21_D.png).
 * Trả về hàm tra tên file -> đường dẫn đầy đủ.
 */
function imageLookup(folder) {
    const key = path.normalize(folder).toLowerCase();
    if (!imageIndexCache.has(key)) {
        const own = indexImages(folder, 0);
        const parent = indexImages(path.dirname(folder), 3);
        imageIndexCache.set(key, (n) => own.get(n.toLowerCase()) || parent.get(n.toLowerCase()) || '');
    }
    return imageIndexCache.get(key);
}

function resolveTexture(folder, name, fbx) {
    const find = imageLookup(folder);
    const lookup = (n) => find(path.basename(n));
    let refs = [];
    try {
        const text = fs.readFileSync(fbx).toString('latin1');
        refs = Array.from(new Set((text.match(/[\w.-]+\.(?:png|jpg|jpeg|tga)/gi) || []).map((s) => s.toLowerCase())));
    } catch (e) {
        refs = [];
    }
    // normal map không dùng được (material Fish chỉ lấy màu), bỏ khỏi danh sách
    refs = Array.from(new Set(refs.map((r) => path.basename(r.replace(/\\/g, '/'))))).filter((r) => !/normal/i.test(r));
    // <tên>.png (Fishdom) hoặc T_<X>_D.png cho SK_<X> (Models/Fish Rig -> Models/Texture/<X>/)
    const own = lookup(name + '.png') || lookup('T_' + name.replace(/^SK_/i, '') + '_D.png');
    const found = Array.from(new Set(refs.map(lookup).filter(Boolean)));
    const missing = refs.filter((r) => !lookup(r));
    const png = own || found[0] || '';
    let warning = '';
    if (!png) {
        warning = 'Không có texture' + (missing.length ? ' (FBX cần: ' + missing.join(', ') + ')' : '');
    } else if (!own && refs.length > 1) {
        warning = 'FBX dùng ' + refs.length + ' texture (' + refs.join(', ') + ') - chỉ lấy ' + path.basename(png) + ', phần còn lại sẽ sai màu';
    }
    return { png, warning };
}

/**
 * Ảnh xem trước (PNG -> data URL) + kích thước gốc của model, cache trong temp/fishdom-importer/preview
 * theo đường dẫn FBX (2 thư mục có thể trùng tên cá).
 */
async function previewFish(opts) {
    const dir = path.join(Editor.Project.path, 'temp', PKG, 'preview');
    // PREVIEW_VERSION đổi khi preview.py đổi cách render (góc camera, đèn) để bỏ cache cũ
    const key = opts.name + '_' + require('crypto').createHash('md5').update(PREVIEW_VERSION + '|' + opts.fbx.toLowerCase() + '|' + (opts.png || '')).digest('hex').slice(0, 8);
    const file = path.join(dir, key + '.png');
    const meta = path.join(dir, key + '.json');
    if (opts.force || !fs.existsSync(file) || !fs.existsSync(meta)) {
        if (!opts.blender || !fs.existsSync(opts.blender)) throw new Error('Không tìm thấy blender.exe');
        fs.mkdirSync(dir, { recursive: true });
        const r = await runBlender(opts.blender, opts.fbx, opts.png, file, 512, 'preview.py');
        fs.writeFileSync(meta, JSON.stringify({ size: r.size }));
    }
    return {
        image: 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'),
        size: JSON.parse(fs.readFileSync(meta, 'utf8')).size,
    };
}

// ---------------------------------------------------------------- assets

/** Đợi asset import xong và có sub-asset thoả `pick`. */
async function waitSubAsset(url, pick) {
    for (let i = 0; i < 40; i++) {
        const info = await Editor.Message.request('asset-db', 'query-asset-info', url).catch(() => null);
        const sub = info && info.subAssets && Object.values(info.subAssets).find(pick);
        if (sub) return sub.uuid;
        await sleep(250);
    }
    throw new Error('Không đọc được sub-asset của ' + url);
}

async function importFile(src, dbUrl, overwrite) {
    const dst = await dbToFs(dbUrl.replace(/\/[^/]+$/, ''));
    const file = path.join(dst, dbUrl.split('/').pop());
    if (overwrite || !fs.existsSync(file)) fs.copyFileSync(src, file);
    await Editor.Message.request('asset-db', 'refresh-asset', dbUrl);
    return file;
}

/** Thiết lập import mesh giống các SK_Fish*.glb mẫu: tối ưu + nén + simplify (ratio 1). */
async function applyMeshSettings(glbUrl) {
    const meta = await Editor.Message.request('asset-db', 'query-asset-meta', glbUrl).catch(() => null);
    if (!meta || !meta.userData) return;
    Object.assign(meta.userData, {
        meshOptimize: { enable: true, vertexCache: true, vertexFetch: true, overdraw: true },
        meshSimplify: { enable: true, targetRatio: 1 },
        meshCompress: { enable: true, encode: false, compress: true, quantize: true },
    });
    await Editor.Message.request('asset-db', 'save-asset-meta', glbUrl, JSON.stringify(meta));
    await Editor.Message.request('asset-db', 'refresh-asset', glbUrl);
}

/** Tên kế tiếp chưa dùng: SK_Fish<max+1> theo các file GLB có sẵn. */
async function nextName() {
    const dir = await dbToFs(MESH_DIR).catch(() => '');
    let max = 0;
    if (dir && fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
            const m = /^SK_Fish(\d+)\.glb$/i.exec(f);
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
    }
    return 'SK_Fish' + (max + 1);
}

// ---------------------------------------------------------------- scene

/**
 * Chuẩn hoá model cá đã nằm trong slot cho giống cá mẫu: layer = layer của slot (UICam chỉ vẽ UI_2D),
 * đầu hướng +Z, tâm mesh ở gốc slot, material slot 0 để trống (Thing.setMeshMat gán material Fish lúc chạy).
 */
async function setupChild(slot, child, report) {
    await setProp(child, 'rotation', { type: 'cc.Vec3', value: { x: 0, y: 0, z: 0 } });
    let m = await sceneScript('measure', slot.uuid, child);

    for (const uuid of m.wrongLayer) {
        await setProp(uuid, 'layer', { type: 'cc.Layers', value: m.slotLayer });
    }
    if (m.wrongLayer.length) report('Đặt layer ' + m.slotLayer + ' cho ' + m.wrongLayer.length + ' node (camera chỉ vẽ layer này)');

    // hướng: đầu cá phải về +Z như các cá khác
    if (m.headForward === false) {
        await setProp(child, 'rotation', { type: 'cc.Vec3', value: { x: 0, y: 180, z: 0 } });
        m = await sceneScript('measure', slot.uuid, child);
        report('Xoay 180° để đầu cá hướng +Z');
    } else if (m.headForward === null) {
        report(m.bodyBones < 2
            ? 'Không phải cá bơi ngang (' + m.bodyBones + ' xương thân) - giữ hướng gốc (mặt nhìn camera)'
            : 'Không có bone "head" - giữ nguyên hướng, kiểm tra tay trong Scene');
    }

    // canh tâm mesh về gốc slot
    const p = m.childPosition;
    const pos = { x: p[0] - m.center[0], y: p[1] - m.center[1], z: p[2] - m.center[2] };
    await setProp(child, 'position', { type: 'cc.Vec3', value: pos });
    report('Vị trí (' + [pos.x, pos.y, pos.z].map((v) => v.toFixed(0)).join(', ') + '), cỡ mesh '
        + m.size.map((v) => v.toFixed(0)).join(' × '));

    // material để trống -> Thing.setMeshMat gán material Fish (room.mat.mats[type]) vào slot 0 lúc chạy
    await setProp(m.meshNode, '__comps__.' + m.meshCompIndex + '.sharedMaterials', {
        type: 'cc.Material', isArray: true, value: [{ type: 'cc.Material', value: { uuid: '' } }],
    });
    if (m.materials.some(Boolean)) report('Bỏ material gốc (' + m.materials.filter(Boolean).join(', ') + ') để game gán material Fish');
    if (m.slots > 1) report('⚠ Mesh có ' + m.slots + ' submesh - chỉ submesh đầu nhận material Fish');
}

/** Animator Unity đã port sang Cocos (Fish.ts: cá; CreatureAnimator.ts: bạch tuộc, cua). */
const PORTED = new Set(['FishRigProceduralAnimator', 'FishdomProceduralAnimator', 'OctopusProceduralAnimator', 'CrabProceduralAnimator']);

/** Gắn FishAnimConfig (tham số animator bake từ prefab Unity) lên node model trong slot. */
async function writeAnimConfig(nodeUuid, u, report) {
    let idx = await sceneScript('componentIndex', nodeUuid, 'FishAnimConfig');
    if (idx < 0) {
        await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: 'FishAnimConfig' });
        idx = await sceneScript('componentIndex', nodeUuid, 'FishAnimConfig');
    }
    if (idx < 0) throw new Error('Không gắn được FishAnimConfig (script đã compile chưa?)');
    const base = '__comps__.' + idx + '.';
    await setProp(nodeUuid, base + 'animator', { type: 'String', value: u.animator });
    await setProp(nodeUuid, base + 'source', { type: 'String', value: u.prefab });
    await setProp(nodeUuid, base + 'orientation', { type: 'Number', value: u.orientation || 0 });
    await setProp(nodeUuid, base + 'paramsJson', { type: 'String', value: JSON.stringify(u.params) });
    report('FishAnimConfig: ' + u.animator + ', ' + Object.keys(u.params).length + ' tham số từ ' + u.prefab);
    if (!PORTED.has(u.animator)) {
        report('⚠ ' + u.animator + ' chưa port sang Cocos - Fish.ts sẽ dùng sóng thân cá / clip thay thế');
    }
}

/**
 * Đặt prefab GLB vào slot giống cá mẫu: SK_FishN > RootNode > <Tên> (mesh) + <Tên>_Rig; bỏ lớp bọc prefab
 * (<tên file> + SkeletalAnimation), skinningRoot của mesh trỏ về slot (đường dẫn joint "RootNode/<Tên>_Rig/..." tính từ đó).
 * GLB gốc (PlayCanvas converter, RootNode scale 0.01) -> scale 50 như các slot gốc. Trả về uuid RootNode.
 */
async function placeModel(slot, prefabUuid, name, report) {
    const wrapper = await Editor.Message.request('scene', 'create-node', { parent: slot.uuid, assetUuid: prefabUuid, name });
    const u = await sceneScript('unwrapInfo', wrapper);
    let child = wrapper;
    if (u.inner) {
        await Editor.Message.request('scene', 'set-parent', { parent: slot.uuid, uuids: [u.inner], keepWorldTransform: false });
        await Editor.Message.request('scene', 'remove-node', { uuid: wrapper });
        child = u.inner;
        if (u.meshNode) {
            await setProp(u.meshNode, '__comps__.' + u.meshCompIndex + '.skinningRoot', { type: 'cc.Node', value: { uuid: slot.uuid } });
        }
        if (u.innerScale < 0.1) {
            await setProp(child, 'scale', { type: 'cc.Vec3', value: { x: 50, y: 50, z: 50 } });
            report('RootNode scale 0.01 -> 50 (như các slot gốc)');
        }
    }
    await setupChild(slot, child, report);
    return child;
}

async function placeInSlot(opts, prefabUuid, textureUuid, report) {
    const slots = await sceneScript('listSlots');
    const slot = slots.slots.find((s) => s.uuid === opts.slotUuid);
    if (!slot) throw new Error('Không thấy slot trong scene hiện tại (mở PlayScene chưa?)');

    if (opts.replace) {
        const info = await Editor.Message.request('scene', 'query-node-tree', slot.uuid);
        for (const c of (info && info.children) || []) {
            await Editor.Message.request('scene', 'remove-node', { uuid: c.uuid });
        }
        report('Đã xoá ' + ((info && info.children.length) || 0) + ' node con cũ của ' + slot.name);
    }

    const child = await placeModel(slot, prefabUuid, opts.outName, report);
    if (opts.unity) await writeAnimConfig(child, opts.unity, report);

    // Mats.textures[index] = texture của cá
    if (slots.mats && textureUuid) {
        const tex = slots.mats.textures.slice();
        while (tex.length <= slot.index) tex.push(null);
        tex[slot.index] = textureUuid;
        await setProp(slots.mats.uuid, '__comps__.' + slots.mats.compIndex + '.textures', {
            type: 'cc.Texture2D', isArray: true,
            value: tex.map((u) => ({ type: 'cc.Texture2D', value: { uuid: u || '' } })),
        });
        report('Mats.textures[' + slot.index + '] = texture của cá');
    } else {
        report('Không thấy component Mats - chưa gán texture');
    }

    if (opts.save) {
        await Editor.Message.request('scene', 'save-scene');
        report('Đã lưu scene');
    }
    return { slot: slot.name, index: slot.index, node: child };
}

// ---------------------------------------------------------------- Fish Level Setup

const ROOM_TS = 'db://assets/7.Scripts/Gameplay/Room.ts';
const BUBBLE_RE = /(export const BubbleData:\s*\r?\n\s*\[number, number, number\[\]\]\[\]\s*=\s*\r?\n)([^\r\n]*)/;
const ITEMS_RE = /export const Items = \[[\s\S]*?\r?\n\][ \t]*\r?\n/;

/** Tên node mesh (có skin) trong GLB - tên model (Fish20, Fish24, african_jewelfish...). */
function glbModelName(file) {
    try {
        const d = fs.readFileSync(file);
        const len = d.readUInt32LE(12);
        const j = JSON.parse(d.toString('utf8', 20, 20 + len));
        const n = (j.nodes || []).find((x) => x.mesh !== undefined && x.skin !== undefined) || (j.nodes || []).find((x) => x.mesh !== undefined);
        return n && n.name ? n.name : '';
    } catch (e) {
        return '';
    }
}

/** Số lần mỗi loại cá xuất hiện trong BubbleData của Room.ts. */
function bubbleUsage(src) {
    const m = BUBBLE_RE.exec(src);
    const usage = {};
    if (!m) return usage;
    try {
        for (const [, , types] of JSON.parse(m[2])) for (const t of types) usage[t] = (usage[t] || 0) + 1;
    } catch (e) { /* data lỗi: bỏ qua */ }
    return usage;
}

/** Items: mỗi loại cá n con -> n/3 nhóm [t, t, t], xáo trộn (thứ tự hộp ra slot). */
function buildItems(data) {
    const count = {};
    for (const [, , types] of data) for (const t of types) count[t] = (count[t] || 0) + 1;
    const items = [];
    for (const t of Object.keys(count)) for (let i = 0; i < Math.floor(count[t] / 3); i++) items.push([+t, +t, +t]);
    for (let i = items.length - 1; i > 0; i--) {
        const k = Math.floor(Math.random() * (i + 1));
        [items[i], items[k]] = [items[k], items[i]];
    }
    return items;
}

function formatItems(items) {
    const cell = (a) => ('[ ' + a.join(', ') + ' ],').padEnd(16);
    const lines = [];
    for (let i = 0; i < items.length; i += 2) lines.push('  ' + items.slice(i, i + 2).map(cell).join(' ').trimEnd());
    if (lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
    return 'export const Items = [ \n' + lines.join('\n') + ' \n] \n';
}

/** Ghi BubbleData + Items vào Room.ts (giữ nguyên phần còn lại của file). */
async function writeRoomData(data, items) {
    const file = await dbToFs(ROOM_TS);
    let src = fs.readFileSync(file, 'utf8');
    if (!BUBBLE_RE.test(src)) throw new Error('Không tìm thấy khai báo BubbleData trong Room.ts');
    if (!ITEMS_RE.test(src)) throw new Error('Không tìm thấy khai báo Items trong Room.ts');
    src = src.replace(BUBBLE_RE, (_, head) => head + JSON.stringify(data));
    src = src.replace(ITEMS_RE, formatItems(items));
    fs.writeFileSync(file, src);
    await Editor.Message.request('asset-db', 'refresh-asset', ROOM_TS);
}

/** Cá trong project: mỗi SK_FishN.glb = loại N-1 (slot SK_Fish<N-1>), kèm trạng thái trong scene / level. */
async function listProjectFish() {
    const meshDir = await dbToFs(MESH_DIR);
    const texDir = await dbToFs(TEX_DIR);
    const level = await sceneScript('levelInfo');
    let usage = {};
    try { usage = bubbleUsage(fs.readFileSync(await dbToFs(ROOM_TS), 'utf8')); } catch (e) { /* không đọc được Room.ts */ }
    const texFiles = fs.existsSync(texDir) ? fs.readdirSync(texDir) : [];
    const findTex = (n) => { const f = texFiles.find((x) => x.toLowerCase() === n.toLowerCase()); return f ? path.join(texDir, f) : ''; };
    const fishTypes = level.room ? level.room.fishTypes : [];
    const list = [];
    for (const f of fs.readdirSync(meshDir)) {
        const m = /^SK_Fish(\d+)\.glb$/i.exec(f);
        if (!m) continue;
        const index = parseInt(m[1], 10) - 1;
        const file = path.join(meshDir, f);
        const model = glbModelName(file);
        const png = findTex('T_' + model + '_D.png') || findTex(model + '.png') || findTex('T_Fish' + m[1] + '_D.png');
        const slot = level.slots[index];
        list.push({
            name: f.replace(/\.glb$/i, ''), file, url: MESH_DIR + '/' + f, index, model, png,
            mtime: fs.statSync(file).mtimeMs,
            slotModel: slot ? slot.model : null,
            inScene: !!slot && slot.model === model,
            playing: fishTypes.includes(index),
            usage: usage[index] || 0,
        });
    }
    list.sort((a, b) => a.index - b.index);
    return { fish: list, fishTypes, bubbles: level.bubbles, bubbleFish: level.bubbleFish, slots: level.slots.length, ok: !!(level.fishRoot && level.room) };
}

/**
 * Áp dụng danh sách cá được chơi: slot (node Fish), Mats.textures, Room.fishTypes, BubbleData + Items trong Room.ts, scene.
 * opts: { selected: [index], clearUnused, regen, save }
 */
async function applyLevel(opts) {
    const lines = [];
    const report = (s) => { lines.push(s); log(s); };
    try {
        const selected = Array.from(new Set(opts.selected || [])).sort((a, b) => a - b);
        if (!selected.length) throw new Error('Chưa chọn con cá nào');
        const all = (await listProjectFish()).fish;
        const pick = selected.map((i) => all.find((f) => f.index === i)).filter(Boolean);
        let level = await sceneScript('levelInfo');
        if (!level.fishRoot || !level.room) throw new Error('Không thấy node Fish / component Room - mở PlayScene trước');

        // 1. đủ slot SK_Fish0..max (slot mới: cùng hướng + layer với slot đầu)
        const maxIdx = Math.max(...selected);
        const tpl = level.slots[0];
        for (let i = level.slots.length; i <= maxIdx; i++) {
            const uuid = await Editor.Message.request('scene', 'create-node', { parent: level.fishRoot.uuid, name: 'SK_Fish' + i });
            if (tpl) await setProp(uuid, 'rotation', { type: 'cc.Vec3', value: { x: tpl.rot[0], y: tpl.rot[1], z: tpl.rot[2] } });
            await setProp(uuid, 'layer', { type: 'cc.Layers', value: level.fishRoot.layer });
            report('Tạo slot SK_Fish' + i);
        }
        level = await sceneScript('levelInfo');

        // 2. model vào slot (slot đang đúng model thì giữ nguyên)
        const slotsInfo = await sceneScript('listSlots');
        const tex = slotsInfo.mats ? slotsInfo.mats.textures.slice() : [];
        for (const f of pick) {
            const slot = level.slots[f.index];
            if (slot.model !== f.model) {
                for (const c of slot.children) await Editor.Message.request('scene', 'remove-node', { uuid: c });
                const prefab = await waitSubAsset(f.url, (s) => /\.prefab$/.test(s.name));
                await placeModel(slot, prefab, f.name, () => {});
                report('Slot ' + f.index + ' (' + slot.name + '): đặt ' + f.name + ' (' + f.model + ')');
            }
            if (f.png) {
                const texUrl = await Editor.Message.request('asset-db', 'query-url', f.png);
                const texUuid = await waitSubAsset(texUrl, (s) => s.type === 'cc.Texture2D');
                while (tex.length <= f.index) tex.push(null);
                if (tex[f.index] !== texUuid) report('Mats.textures[' + f.index + '] = ' + path.basename(f.png));
                tex[f.index] = texUuid;
            } else {
                report('⚠ ' + f.name + ': không tìm thấy texture (T_' + f.model + '_D.png)');
            }
        }

        // 3. slot không chọn: dọn model (như cấu hình gốc - chỉ loại được chơi có model)
        if (opts.clearUnused) {
            for (const slot of level.slots) {
                if (selected.includes(slot.index) || !slot.children.length) continue;
                for (const c of slot.children) await Editor.Message.request('scene', 'remove-node', { uuid: c });
                report('Dọn slot ' + slot.index + ' (' + slot.name + ', ' + (slot.model || 'trống') + ')');
            }
        }

        // 4. Mats.textures + Room.fishTypes
        if (slotsInfo.mats) {
            await setProp(slotsInfo.mats.uuid, '__comps__.' + slotsInfo.mats.compIndex + '.textures', {
                type: 'cc.Texture2D', isArray: true, value: tex.map((u) => ({ type: 'cc.Texture2D', value: { uuid: u || '' } })),
            });
        }
        await setProp(level.room.uuid, '__comps__.' + level.room.compIndex + '.fishTypes', {
            type: 'Number', isArray: true, value: selected.map((v) => ({ type: 'Number', value: v })),
        });
        report('Room.fishTypes = [' + selected.join(', ') + ']');

        // 5. BubbleData + Items: giữ vị trí / cỡ bubble đang có, chia lại loại cá (Gen Buble From Avai)
        let data = null;
        if (opts.regen) {
            data = await sceneScript('genBubbles', selected);
            if (!data.length) throw new Error('Scene không có bubble nào để gen (initBubbles chưa chạy?)');
            const items = buildItems(data);
            const count = {};
            data.forEach(([, , t]) => t.forEach((x) => { count[x] = (count[x] || 0) + 1; }));
            report('Gen ' + data.length + ' bubble, ' + items.length + ' hộp: ' + Object.keys(count).map((k) => 'loại ' + k + ' × ' + count[k]).join(', '));
            if (opts.save) {
                await Editor.Message.request('scene', 'save-scene');
                report('Đã lưu scene');
            }
            await writeRoomData(data, items);
            report('Đã ghi BubbleData + Items vào Room.ts');
            // Room.ts compile lại -> nạp lại scene để initBubbles dùng data mới
            await sleep(6000);
            await Editor.Message.request('scene', 'soft-reload').catch(() => {});
            report('Đã nạp lại scene với BubbleData mới');
        } else if (opts.save) {
            await Editor.Message.request('scene', 'save-scene');
            report('Đã lưu scene');
        }
        return { ok: true, log: lines };
    } catch (e) {
        report('LỖI: ' + (e && e.message ? e.message : e));
        return { ok: false, log: lines };
    }
}

// ---------------------------------------------------------------- messages

exports.methods = {
    openPanel() {
        Editor.Panel.open(PKG);
    },

    openLevelPanel() {
        Editor.Panel.open(PKG + '.level');
    },

    listProjectFish() {
        return listProjectFish();
    },

    /** Ảnh xem trước của GLB trong project (cache theo tên + thời điểm sửa file). */
    async previewProjectFish(opts) {
        try {
            return Object.assign({ ok: true }, await previewFish({
                blender: opts.blender, name: opts.name + '_' + Math.round(opts.mtime || 0), fbx: opts.file, png: opts.png, force: opts.force,
            }));
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
        }
    },

    applyLevel(opts) {
        return applyLevel(opts);
    },

    detectBlender() {
        return detectBlender();
    },

    async listFish(folder, force) {
        const list = [];
        if (unity.isUnityProject(folder)) {
            // project Unity: mỗi prefab có *ProceduralAnimator là một con, kèm tham số animator để bake
            for (const f of unity.scanProject(folder, force)) {
                if (!f.fbx) continue;
                let { png, warning } = f;
                if (!png) {
                    const tex = resolveTexture(path.dirname(f.fbx), path.basename(f.fbx, path.extname(f.fbx)), f.fbx);
                    png = tex.png;
                    warning = tex.warning;
                }
                list.push({ name: f.name, fbx: f.fbx, png, warning, unity: f.unity });
            }
            return { fish: list, nextName: await nextName(), unityProject: true };
        }
        if (folder && fs.existsSync(folder)) {
            for (const f of fs.readdirSync(folder).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
                if (!/\.fbx$/i.test(f)) continue;
                const name = f.replace(/\.fbx$/i, '');
                const fbx = path.join(folder, f);
                const tex = resolveTexture(folder, name, fbx);
                list.push({ name, fbx, png: tex.png, warning: tex.warning });
            }
        }
        return { fish: list, nextName: await nextName() };
    },

    async listSlots() {
        return sceneScript('listSlots');
    },

    /** opts: { blender, name, fbx, png, force } -> { ok, image (data URL), size [x,y,z] gốc | error } */
    async previewFish(opts) {
        try {
            return Object.assign({ ok: true }, await previewFish(opts));
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
        }
    },

    /** Chuẩn hoá lại model đang có sẵn trong slot (layer, hướng, tâm, material) mà không import lại. opts: { slotUuid, save } */
    async fixSlot(opts) {
        const lines = [];
        const report = (s) => { lines.push(s); log(s); };
        try {
            const slots = await sceneScript('listSlots');
            const slot = slots.slots.find((s) => s.uuid === opts.slotUuid);
            if (!slot) throw new Error('Không thấy slot');
            const child = await sceneScript('slotChild', slot.uuid);
            if (!child) throw new Error(slot.name + ' đang trống');
            report('Sửa ' + slot.name + ' > ' + child.name);
            await setupChild(slot, child.uuid, report);
            if (slots.mats && !slots.mats.textures[slot.index]) report('⚠ Mats.textures[' + slot.index + '] đang trống - cá sẽ không có texture');
            if (opts.save) {
                await Editor.Message.request('scene', 'save-scene');
                report('Đã lưu scene');
            }
            return { ok: true, log: lines };
        } catch (e) {
            report('LỖI: ' + (e && e.message ? e.message : e));
            return { ok: false, log: lines };
        }
    },

    /**
     * opts: { blender, fbx, png, outName, scale, slotUuid, replace, save }
     * Trả về { ok, log[] }.
     */
    async importFish(opts) {
        const lines = [];
        const report = (s) => { lines.push(s); log(s); };
        try {
            if (!opts.blender || !fs.existsSync(opts.blender)) throw new Error('Không tìm thấy blender.exe');
            if (!opts.fbx || !fs.existsSync(opts.fbx)) throw new Error('Không tìm thấy file FBX');
            const outName = (opts.outName || '').trim();
            if (!/^[\w-]+$/.test(outName)) throw new Error('Tên file GLB không hợp lệ');
            const fishName = path.basename(opts.fbx).replace(/\.fbx$/i, '');
            // tên theo slot như các cá mẫu: SK_Fish24 -> mesh Fish24, skeleton Fish24_Rig, texture T_Fish24_D.png
            const baseName = outName.replace(/^SK_/i, '');

            report('Blender: chuyển ' + fishName + '.fbx (scale ×' + opts.scale + ')...');
            const tmp = path.join(Editor.Project.path, 'temp', PKG, outName + '.glb');
            fs.mkdirSync(path.dirname(tmp), { recursive: true });
            const r = await runBlender(opts.blender, opts.fbx, opts.png, tmp, opts.scale, 'convert.py', [baseName]);
            report('GLB: ' + r.meshes + ' mesh, ' + r.bones + ' xương, ' + r.tris + ' tam giác, cỡ ' + r.size.join(' × '));
            const body = (r.boneNames || []).filter((n) => /^(Spine|Tail|body)_?\d+$/i.test(n)).length;
            if (body < 2 && !(opts.unity && PORTED.has(opts.unity.animator))) {
                // không phải cá: CreatureAnimator nhận bạch tuộc / cua theo bone, loài khác dùng clip có sẵn (nếu có)
                report('Chỉ ' + body + ' xương thân - Fish.ts dùng animator bạch tuộc / cua nếu nhận ra rig, không thì '
                    + ((r.clips && r.clips.length) ? 'phát clip có sẵn (' + r.clips.join(', ') + ')' : 'con này sẽ đứng yên'));
            }

            const glbUrl = MESH_DIR + '/' + outName + '.glb';
            await importFile(tmp, glbUrl, true);
            await applyMeshSettings(glbUrl);
            const prefabUuid = await waitSubAsset(glbUrl, (s) => /\.prefab$/.test(s.name));
            report('Đã import ' + glbUrl);

            let textureUuid = '';
            if (opts.png) {
                const texUrl = TEX_DIR + '/T_' + baseName + '_D' + path.extname(opts.png).toLowerCase();
                await importFile(opts.png, texUrl, true);
                textureUuid = await waitSubAsset(texUrl, (s) => s.type === 'cc.Texture2D');
                report('Texture ' + texUrl);
            } else {
                report('Không có PNG cùng tên - bỏ qua texture');
            }

            if (opts.slotUuid) {
                const placed = await placeInSlot(Object.assign({}, opts, { outName }), prefabUuid, textureUuid, report);
                report('Xong: ' + outName + ' đã vào ' + placed.slot + ' (loại cá ' + placed.index + ')');
            } else {
                report('Xong: chỉ import asset, không đặt vào slot' + (opts.unity ? ' (tham số animator Unity chỉ được lưu khi đặt vào slot)' : ''));
            }
            return { ok: true, log: lines };
        } catch (e) {
            report('LỖI: ' + (e && e.message ? e.message : e));
            return { ok: false, log: lines };
        }
    },
};

exports.load = function () {};
exports.unload = function () {};
