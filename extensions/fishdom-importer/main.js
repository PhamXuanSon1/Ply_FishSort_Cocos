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

const PKG = 'fishdom-importer';
const MESH_DIR = 'db://assets/8.Models/Meshes/Fishes';
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

function runBlender(blender, fbx, png, out, scale, scriptName = 'convert.py') {
    const script = path.join(__dirname, 'scripts', scriptName);
    const args = ['-b', '--factory-startup', '--python', script, '--', fbx, png || '', out, String(scale)];
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
    const key = opts.name + '_' + require('crypto').createHash('md5').update(opts.fbx.toLowerCase()).digest('hex').slice(0, 8);
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

    const child = await Editor.Message.request('scene', 'create-node', {
        parent: slot.uuid, assetUuid: prefabUuid, name: opts.outName,
    });
    await setupChild(slot, child, report);

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

// ---------------------------------------------------------------- messages

exports.methods = {
    openPanel() {
        Editor.Panel.open(PKG);
    },

    detectBlender() {
        return detectBlender();
    },

    async listFish(folder) {
        const list = [];
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

            report('Blender: chuyển ' + fishName + '.fbx (scale ×' + opts.scale + ')...');
            const tmp = path.join(Editor.Project.path, 'temp', PKG, outName + '.glb');
            fs.mkdirSync(path.dirname(tmp), { recursive: true });
            const r = await runBlender(opts.blender, opts.fbx, opts.png, tmp, opts.scale);
            report('GLB: ' + r.meshes + ' mesh, ' + r.bones + ' xương, ' + r.tris + ' tam giác, cỡ ' + r.size.join(' × '));
            const body = (r.boneNames || []).filter((n) => /^(Spine|Tail|body)_?\d+$/i.test(n)).length;
            if (body < 2) {
                report((r.clips && r.clips.length)
                    ? 'Chỉ ' + body + ' xương thân - Fish.ts sẽ phát animation clip có sẵn (' + r.clips.join(', ') + ')'
                    : '⚠ Chỉ ' + body + ' xương thân và không có animation clip - con này sẽ đứng yên');
            }

            const glbUrl = MESH_DIR + '/' + outName + '.glb';
            await importFile(tmp, glbUrl, true);
            const prefabUuid = await waitSubAsset(glbUrl, (s) => /\.prefab$/.test(s.name));
            report('Đã import ' + glbUrl);

            let textureUuid = '';
            if (opts.png) {
                const texUrl = TEX_DIR + '/' + path.basename(opts.png);
                await importFile(opts.png, texUrl, false);
                textureUuid = await waitSubAsset(texUrl, (s) => s.type === 'cc.Texture2D');
                report('Texture ' + texUrl);
            } else {
                report('Không có PNG cùng tên - bỏ qua texture');
            }

            if (opts.slotUuid) {
                const placed = await placeInSlot(Object.assign({}, opts, { outName }), prefabUuid, textureUuid, report);
                report('Xong: ' + outName + ' đã vào ' + placed.slot + ' (loại cá ' + placed.index + ')');
            } else {
                report('Xong: chỉ import asset, không đặt vào slot');
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
