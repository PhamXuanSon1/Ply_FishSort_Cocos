'use strict';
/**
 * Đọc project Unity (vd F:\AssetFish\FishSort-new-item) để bake cá: tìm mọi prefab có component *ProceduralAnimator,
 * lấy tên class animator + field số (tham số animation), FishModel.Orientation, FBX nguồn (PrefabInstance.m_SourcePrefab)
 * và texture (material override trong prefab, không có thì material remap trong .meta của FBX -> .mat -> _BaseMap/_MainTex).
 * Chỉ đọc YAML dạng text (Unity lưu prefab / meta / mat ở chế độ Force Text), không cần Unity.
 */

const fs = require('fs');
const path = require('path');

const cache = new Map(); // projectRoot -> { guids, scanned }

function isUnityProject(dir) {
    return !!dir && fs.existsSync(path.join(dir, 'Assets')) && fs.existsSync(path.join(dir, 'ProjectSettings'));
}

/** Mọi file dưới dir (bỏ thư mục ẩn / Library). */
function walk(dir, out = []) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return out;
    }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

/** Chỉ cần guid của các loại asset này (script, prefab, model, material, ảnh) - bỏ qua json / âm thanh... cho nhanh. */
const INDEXED = /\.(cs|prefab|fbx|mat|png|tga|jpg|jpeg|psd)\.meta$/i;

/** guid -> đường dẫn asset (bỏ đuôi .meta). */
function indexGuids(assetsDir) {
    const guids = new Map();
    for (const f of walk(assetsDir)) {
        if (!INDEXED.test(f)) continue;
        let head = '';
        try {
            const fd = fs.openSync(f, 'r');
            const buf = Buffer.alloc(200);
            const n = fs.readSync(fd, buf, 0, 200, 0);
            fs.closeSync(fd);
            head = buf.toString('utf8', 0, n);
        } catch (e) {
            continue;
        }
        const m = /guid:\s*([0-9a-f]{32})/.exec(head);
        if (m) guids.set(m[1], f.slice(0, -5));
    }
    return guids;
}

/** Tách YAML Unity thành document: { classId, fileId, stripped, body }. */
function splitDocs(text) {
    const docs = [];
    const re = /^--- !u!(\d+) &(-?\d+)( stripped)?\s*$/gm;
    let m;
    let last = null;
    while ((m = re.exec(text))) {
        if (last) last.body = text.slice(last.start, m.index);
        last = { classId: +m[1], fileId: m[2], stripped: !!m[3], start: re.lastIndex };
        docs.push(last);
    }
    if (last) last.body = text.slice(last.start);
    return docs;
}

const guidOf = (s) => ((/guid:\s*([0-9a-f]{32})/.exec(s || '') || [])[1] || '');

/** Field số cấp 1 của MonoBehaviour (bỏ m_*): "  armBias: 33" -> { armBias: 33 }. */
function numericFields(body) {
    const out = {};
    const re = /^  ([A-Za-z_]\w*):\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$/gm;
    let m;
    while ((m = re.exec(body))) {
        if (!m[1].startsWith('m_')) out[m[1]] = parseFloat(m[2]);
    }
    return out;
}

/** Texture màu của một .mat (URP _BaseMap, Built-in _MainTex...). */
function materialTexture(matPath, guids) {
    let text = '';
    try {
        text = fs.readFileSync(matPath, 'utf8');
    } catch (e) {
        return '';
    }
    for (const key of ['_BaseMap', '_MainTex', '_BaseColorMap', '_Albedo', '_MainTexture']) {
        const re = new RegExp('- ' + key + ':\\s*\\n\\s*m_Texture:\\s*(\\{[^}]*\\})');
        const m = re.exec(text);
        const g = m && guidOf(m[1]);
        if (g && guids.has(g)) return guids.get(g);
    }
    const any = /m_Texture:\s*\{fileID: 2800000, guid: ([0-9a-f]{32})/.exec(text);
    return any && guids.has(any[1]) ? guids.get(any[1]) : '';
}

/** Material remap trong .meta của FBX (externalObjects). */
function fbxMaterials(fbxPath, guids) {
    let text = '';
    try {
        text = fs.readFileSync(fbxPath + '.meta', 'utf8');
    } catch (e) {
        return [];
    }
    const out = [];
    const re = /type: UnityEngine:Material[\s\S]*?second:\s*(\{[^}]*\})/g;
    let m;
    while ((m = re.exec(text))) {
        const g = guidOf(m[1]);
        if (g && guids.has(g)) out.push(guids.get(g));
    }
    return out;
}

/**
 * Quét project: danh sách cá (prefab có *ProceduralAnimator).
 * Trả về [{ name, prefab, fbx, png, warning, unity: { animator, params, orientation, faceCameraLean, prefab } }].
 */
function scanProject(root, force) {
    const key = path.normalize(root).toLowerCase();
    if (!force && cache.has(key)) return cache.get(key);
    const assets = path.join(root, 'Assets');
    const guids = indexGuids(assets);

    const animatorScripts = new Map(); // guid -> class
    let fishModelGuid = '';
    for (const [g, p] of guids) {
        const base = path.basename(p);
        if (/ProceduralAnimator\.cs$/.test(base)) animatorScripts.set(g, base.slice(0, -3));
        else if (base === 'FishModel.cs') fishModelGuid = g;
    }

    const list = [];
    for (const [, p] of guids) {
        if (!p.endsWith('.prefab')) continue;
        let text = '';
        try {
            text = fs.readFileSync(p, 'utf8');
        } catch (e) {
            continue;
        }
        let hasAnimator = false;
        for (const g of animatorScripts.keys()) if (text.includes(g)) { hasAnimator = true; break; }
        if (!hasAnimator) continue;

        const docs = splitDocs(text);
        let animator = '';
        let params = {};
        let orientation = 0;
        let faceCameraLean = 0;
        let fbx = '';
        let matOverride = '';
        for (const d of docs) {
            if (d.classId === 114) {
                const g = guidOf((/m_Script:\s*(\{[^}]*\})/.exec(d.body) || [])[1]);
                if (animatorScripts.has(g) && !animator) {
                    animator = animatorScripts.get(g);
                    params = numericFields(d.body);
                } else if (g && g === fishModelGuid) {
                    const f = numericFields(d.body);
                    orientation = f.Orientation || 0;
                    faceCameraLean = f.FaceCameraLean || 0;
                }
            } else if (d.classId === 1001) {
                const src = guids.get(guidOf((/m_SourcePrefab:\s*(\{[^}]*\})/.exec(d.body) || [])[1])) || '';
                if (/\.fbx$/i.test(src) && !fbx) {
                    fbx = src;
                    const mo = /propertyPath: m_Materials\.Array\.data\[0\]\s*\n\s*value:.*\n\s*objectReference:\s*(\{[^}]*\})/.exec(d.body);
                    const mg = mo && guidOf(mo[1]);
                    if (mg && guids.has(mg)) matOverride = guids.get(mg);
                }
            }
        }
        if (!animator) continue;

        let png = '';
        let warning = '';
        const mats = matOverride ? [matOverride] : (fbx ? fbxMaterials(fbx, guids) : []);
        for (const m of mats) {
            png = materialTexture(m, guids);
            if (png) break;
        }
        if (!fbx) warning = 'Prefab không trỏ tới FBX nào';
        else if (!png) warning = 'Không tìm thấy texture qua material - sẽ dò theo tên file';

        list.push({
            name: path.basename(p, '.prefab'),
            prefab: p,
            fbx,
            png,
            warning,
            unity: { animator, params, orientation, faceCameraLean, prefab: path.relative(root, p).replace(/\\/g, '/') },
        });
    }
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    cache.set(key, list);
    return list;
}

module.exports = { isUnityProject, scanProject };
