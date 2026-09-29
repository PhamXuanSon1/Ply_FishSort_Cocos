'use strict';
/**
 * Scene script - chạy trong tiến trình Scene (có `cc`), gọi từ main.js qua
 *   Editor.Message.request('scene', 'execute-scene-script', { name: 'fishdom-importer', method, args })
 * Chỉ ĐỌC scene (liệt kê slot, đo mesh); mọi thay đổi đều đi qua message 'scene' ở main.js để có undo + lưu đúng.
 */
const { director, Node, SkinnedMeshRenderer, Mat4, Vec3 } = require('cc');

function walk(node, fn) {
    fn(node);
    for (const c of node.children) walk(c, fn);
}

function findByUuid(uuid) {
    let found = null;
    walk(director.getScene(), (n) => { if (!found && n.uuid === uuid) found = n; });
    return found;
}

/** Node chứa các cá mẫu: node tên "Fish" có con tên SK_Fish*. */
function findFishRoot() {
    let found = null;
    walk(director.getScene(), (n) => {
        if (!found && n.name === 'Fish' && n.children.some((c) => /^SK_Fish/i.test(c.name))) found = n;
    });
    return found;
}

/** Component Mats (node MatCustom) - nơi giữ texture theo loại cá: textures[index]. */
function findMats() {
    let result = null;
    walk(director.getScene(), (n) => {
        if (result) return;
        const i = n.components.findIndex((c) => c.constructor && c.constructor.name === 'Mats');
        if (i >= 0) result = { node: n, index: i, comp: n.components[i] };
    });
    return result;
}

/** Bounds mesh sau skinning (CPU) trong local space của `space`. */
function skinnedBounds(renderer, space) {
    const skel = renderer.skeleton;
    const root = renderer.skinningRoot || renderer.node;
    const mesh = renderer.mesh;
    const pos = mesh.readAttribute(0, 'a_position');
    const inv = new Mat4();
    Mat4.invert(inv, space.worldMatrix);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const v = new Vec3(), acc = new Vec3(), t = new Vec3();
    const push = (p) => {
        Vec3.transformMat4(p, p, inv);
        [p.x, p.y, p.z].forEach((c, j) => { if (c < min[j]) min[j] = c; if (c > max[j]) max[j] = c; });
    };
    if (skel) {
        const jts = mesh.readAttribute(0, 'a_joints');
        const wts = mesh.readAttribute(0, 'a_weights');
        const jm = skel.joints.map((p, i) => {
            const n = root.getChildByPath(p);
            const m = new Mat4();
            if (n) Mat4.multiply(m, n.worldMatrix, skel.bindposes[i]);
            return m;
        });
        for (let i = 0; i < pos.length / 3; i++) {
            v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
            acc.set(0, 0, 0);
            for (let k = 0; k < 4; k++) {
                const w = wts[i * 4 + k];
                if (!w) continue;
                Vec3.transformMat4(t, v, jm[jts[i * 4 + k]]);
                Vec3.scaleAndAdd(acc, acc, t, w);
            }
            push(acc);
        }
    } else {
        for (let i = 0; i < pos.length / 3; i++) {
            v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
            Vec3.transformMat4(t, v, renderer.node.worldMatrix);
            push(t);
        }
    }
    return {
        center: min.map((a, j) => (a + max[j]) / 2),
        size: min.map((a, j) => max[j] - a),
    };
}

exports.methods = {
    /** Danh sách slot SK_Fish* + texture hiện có trong Mats. */
    listSlots() {
        const root = findFishRoot();
        const mats = findMats();
        return {
            fishRoot: root ? { uuid: root.uuid, name: root.name } : null,
            slots: root ? root.children.map((c, index) => ({
                index,
                name: c.name,
                uuid: c.uuid,
                children: c.children.map((x) => x.name),
            })) : [],
            mats: mats ? {
                uuid: mats.node.uuid,
                compIndex: mats.index,
                textures: (mats.comp.textures || []).map((t) => (t ? t._uuid : null)),
            } : null,
        };
    },

    /**
     * Đo cá vừa đặt vào slot: tâm mesh (local slot), hướng đầu (+Z/-Z theo bone "head" so với tâm),
     * và node chứa SkinnedMeshRenderer để main.js để trống material.
     */
    measure(slotUuid, childUuid) {
        const slot = findByUuid(slotUuid);
        const child = findByUuid(childUuid);
        if (!slot || !child) throw new Error('Không tìm thấy node slot / cá vừa tạo');
        const renderer = child.getComponentInChildren(SkinnedMeshRenderer);
        if (!renderer || !renderer.mesh) throw new Error('Cá không có SkinnedMeshRenderer');
        const b = skinnedBounds(renderer, slot);

        // chỉ xoay theo bone head với cá (>= 2 xương thân, bơi ngang); cua / bạch tuộc... giữ mặt nhìn camera như model gốc
        let head = null;
        let bodyBones = 0;
        walk(child, (n) => {
            if (!head && n.name.toLowerCase() === 'head') head = n;
            if (/^(Spine|Tail|body)_?\d+$/i.test(n.name)) bodyBones++;
        });
        if (bodyBones < 2) head = null;
        let headZ = null;
        if (head) {
            const p = new Vec3();
            slot.inverseTransformPoint(p, head.worldPosition);
            headZ = p.z;
        }
        // node khác layer của slot: camera (UICam) chỉ vẽ layer của cá mẫu (UI_2D), prefab mới tạo lại ở DEFAULT
        const wrongLayer = [];
        walk(child, (n) => { if (n.layer !== slot.layer) wrongLayer.push(n.uuid); });
        return {
            center: b.center,
            size: b.size,
            headZ,
            headForward: headZ === null ? null : headZ >= b.center[2], // quy ước project: đầu cá hướng +Z
            bodyBones,
            childPosition: [child.position.x, child.position.y, child.position.z],
            childRotation: [child.eulerAngles.x, child.eulerAngles.y, child.eulerAngles.z],
            meshNode: renderer.node.uuid,
            meshCompIndex: renderer.node.components.indexOf(renderer),
            slots: renderer.sharedMaterials.length,
            materials: renderer.sharedMaterials.map((m) => (m ? m.name : null)),
            slotLayer: slot.layer,
            wrongLayer,
        };
    },

    /** Vị trí component theo tên class trên node (-1 nếu không có), để set-property '__comps__.<i>.field'. */
    componentIndex(nodeUuid, className) {
        const node = findByUuid(nodeUuid);
        if (!node) return -1;
        return node.components.findIndex((c) => c.constructor && c.constructor.name === className);
    },

    /**
     * Prefab GLB vừa tạo = <tên file> [SkeletalAnimation] > RootNode > mesh + rig. Cá mẫu chỉ giữ RootNode trong slot:
     * trả về RootNode + SkinnedMeshRenderer (để trỏ skinningRoot về slot sau khi bỏ lớp bọc).
     */
    unwrapInfo(wrapperUuid) {
        const wrapper = findByUuid(wrapperUuid);
        if (!wrapper) throw new Error('Không tìm thấy node vừa tạo');
        const inner = wrapper.children.length === 1 ? wrapper.children[0] : null;
        const renderer = wrapper.getComponentInChildren(SkinnedMeshRenderer);
        return {
            inner: inner ? inner.uuid : null,
            innerScale: inner ? inner.scale.x : 1,
            meshNode: renderer ? renderer.node.uuid : null,
            meshCompIndex: renderer ? renderer.node.components.indexOf(renderer) : -1,
        };
    },

    // ---------------- Fish Level Setup ----------------

    /** Trạng thái level: slot (model đang đặt), Room.fishTypes, bubble đang có trong scene. */
    levelInfo() {
        const root = findFishRoot();
        let room = null;
        walk(director.getScene(), (n) => {
            if (!room) room = n.components.find((c) => c.constructor && c.constructor.name === 'Room') || null;
        });
        const bubbles = room && room.thingNode ? room.thingNode.children.filter((c) => c.components.some((k) => k.constructor && k.constructor.name === 'Bubble')) : [];
        return {
            fishRoot: root ? { uuid: root.uuid, layer: root.children[0] ? root.children[0].layer : root.layer } : null,
            slots: root ? root.children.map((s, index) => {
                const smr = s.getComponentInChildren(SkinnedMeshRenderer);
                return {
                    index, uuid: s.uuid, name: s.name,
                    model: smr ? smr.node.name : null,
                    mesh: smr && smr.mesh ? smr.mesh._uuid.split('@')[0] : null,
                    children: s.children.map((c) => c.uuid),
                    rot: [s.eulerAngles.x, s.eulerAngles.y, s.eulerAngles.z],
                };
            }) : [],
            room: room ? { uuid: room.node.uuid, compIndex: room.node.components.indexOf(room), fishTypes: (room.fishTypes || []).slice() } : null,
            bubbles: bubbles.length,
            bubbleFish: bubbles.reduce((sum, b) => {
                let n = 0;
                walk(b, (x) => { if (x.components.some((k) => k.constructor && k.constructor.name === 'Thing')) n++; });
                return sum + n;
            }, 0),
        };
    },

    /** Room.randomFromAvailableBubbles(types): giữ vị trí + cỡ bubble đang có, chia lại loại cá (như nút Gen Buble From Avai). */
    genBubbles(types) {
        let room = null;
        walk(director.getScene(), (n) => {
            if (!room) room = n.components.find((c) => c.constructor && c.constructor.name === 'Room') || null;
        });
        if (!room) throw new Error('Không thấy component Room trong scene');
        const data = room.randomFromAvailableBubbles(types);
        const r3 = (v) => Math.round(v * 1000) / 1000;
        return data.map(([x, y, t]) => [r3(x), r3(y), t]);
    },

    /** Con đầu tiên của slot (model cá đã đặt), để "sửa slot" không cần import lại. */
    slotChild(slotUuid) {
        const slot = findByUuid(slotUuid);
        if (!slot) throw new Error('Không tìm thấy slot');
        const child = slot.children[0];
        return child ? { uuid: child.uuid, name: child.name } : null;
    },
};
