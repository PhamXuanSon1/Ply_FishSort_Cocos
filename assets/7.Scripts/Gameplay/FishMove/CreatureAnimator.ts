import { Node, Quat, Vec3, clamp, clamp01, lerp } from 'cc';
import type { FishAnimConfig } from './FishAnimConfig';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const HIST = 128; // lịch sử tốc độ góc để lấy mẫu trễ theo vị trí trên thân

/**
 * Animator procedural cho sinh vật KHÔNG bơi như cá thường (bạch tuộc, cua, sao biển, cá ngựa, hải cẩu), port từ bản Unity:
 *  - FishPoseJob (FishAnimationJobs.cs), nhánh Wave + SideFin: engine tính pose dùng chung;
 *  - Octopus / Crab / Starfish / Seahorse / SealProceduralAnimator.cs: tìm bone theo tên + cây, bake tham số mỗi bone;
 *  - FishRigProceduralAnimator.cs: Find Bones + hình học vây cho cá ngựa / hải cẩu (rig cá chuẩn);
 *  - CreatureRigUtil.cs: tiện ích tìm bone.
 * Fish.ts gọi CreatureAnimator.tryCreate() lúc build; nhận ra rig thì toàn bộ animation đi qua đây thay vì sóng thân cá.
 *
 * Root space = local space của node gắn component Fish: mặt +Z, lưng +Y, phải +X (model đặt trong slot sao cho mặt nhìn +Z).
 * Mỗi frame, mỗi bone xoay so với bind pose:
 *   góc = Bias + Amp · ampScale · pulse(pha)  quanh trục Axis (0 = up, 1 = dọc thân, 2 = FinAxis root space),
 *   cộng uốn theo hướng rẽ (yaw / pitch / roll đo từ chuyển động của node, lấy mẫu trễ theo Along);
 *   pulse = sin(pha méo PhaseSkew), ép vuông mượt bằng tanh theo PulseSharpen; bone có ScaleAmp thì scale theo pulse (mantle bạch tuộc).
 * Bone có bộ idle riêng (IdleVariant) trộn idle ↔ bơi theo Speed (IdleSpeed .. SwimSpeed), blend làm mượt theo thời gian.
 */

/** Dữ liệu một bone đã bake (tương đương FishBoneData). */
interface WaveBone {
    node: Node;
    bindLocal: Quat;
    bindScale: Vec3;
    sideFin: boolean;       // false = Wave (theo pha thân), true = SideFin (quét + xoắn theo pha vây)
    along: number;          // 0 đầu .. 1 đuôi: trễ sóng thân (waveK) + độ trễ uốn theo đường bơi
    axis: number;           // 0 = up, 1 = dọc thân (+Z), 2 = finAxis
    finAxis: Vec3;          // root space, đơn vị; SideFin: trục gốc -> chóp (trục xoắn)
    twistAmp: number;       // SideFin: độ xoắn quanh finAxis, lệch pha 90° so với quét
    side: number;           // SideFin: -1 trái / +1 phải
    foldScale: number;      // SideFin: hệ số gập ra sau khi bơi nhanh
    pitchBias: number;      // Wave: độ ngả tĩnh quanh trục ngang (root space)
    idlePitchBias: number;
    amp: number;            // độ
    bias: number;           // độ, góc nghỉ lệch khỏi bind pose
    lag: number;            // rad, trừ vào pha
    skew: number;           // méo pha ph + skew·sin(ph)
    sharpen: number;        // 0 = sin, gần 1 = gần vuông
    scaleAmp: Vec3;         // tỉ lệ, (0,0,0) = không scale
    idleVariant: boolean;
    idleAmp: number;
    idleBias: number;
    idleLag: number;
    idleSkew: number;
    idleSharpen: number;
    idleScaleAmp: Vec3;
    bendScale: number;      // uốn yaw theo đường bơi, 0 = không
    pitchBend: boolean;     // uốn thêm theo pitch
    rollBend: number;       // trễ quanh trục dọc thân khi root xoay quanh trục đó
    hasScale: boolean;
}

/** Tham số chung (tương đương FishParams). */
interface CreatureParams {
    swayFrequency: number;      // Hz khi Speed = 1
    swimSwayFrequency: number;  // Hz khi bơi với steadyRhythm (≤ 0 = swayFrequency)
    finFrequency: number;       // Hz pha vây khi Speed = 1 (SideFin)
    swimFinFrequency: number;   // Hz pha vây khi bơi với steadyRhythm (≤ 0 = finFrequency)
    finFold: number;            // độ gập vây ra sau tại Speed = 2
    tailSign: number;           // +1 nếu đuôi nằm phía +Z root space
    steadyRhythm: boolean;      // bơi: nhịp + biên độ theo tham số, không theo Speed
    waveK: number;              // 2π / bước sóng (0 = mọi bone cùng pha trừ lag riêng)
    idleSpeed: number;
    swimSpeed: number;
    blendSmoothing: number;     // 1/s
    turnBend: number;
    pitchBend: number;
    bendDelay: number;
    bendSmoothing: number;
    maxBendPerBone: number;
}

type WaveInit = Partial<Omit<WaveBone, 'node' | 'bindLocal' | 'bindScale' | 'hasScale'>>;

// ---------- Tìm bone (CreatureRigUtil) ----------

const isEnd = (n: Node) => /_end$/i.test(n.name);
const nameStarts = (n: Node, prefix: string) => n.name.toLowerCase().startsWith(prefix.toLowerCase());
const nameHas = (n: Node, part: string) => n.name.toLowerCase().indexOf(part.toLowerCase()) >= 0;
const sideFromName = (n: Node) => /_L$/i.test(n.name) ? -1 : /_R$/i.test(n.name) ? 1 : 0;

/** Bone nông nhất dưới root có tên bắt đầu bằng prefix (Spine_1 thay vì Spine_2). */
function findShallowest(root: Node, prefix: string): Node | null {
    let best: Node | null = null;
    let bestDepth = Infinity;
    const walk = (n: Node, d: number) => {
        for (const c of n.children) {
            if (nameStarts(c, prefix) && !isEnd(c) && d < bestDepth) { best = c; bestDepth = d; }
            walk(c, d + 1);
        }
    };
    walk(root, 0);
    return best;
}

function children(parent: Node | null, prefix: string): Node[] {
    return parent ? parent.children.filter(c => nameStarts(c, prefix) && !isEnd(c)) : [];
}

function child(parent: Node | null, prefix: string): Node | null {
    return children(parent, prefix)[0] || null;
}

/** Chuỗi đốt: root rồi lần lượt con đầu tiên không phải *_end. */
function chain(root: Node | null): Node[] {
    const list: Node[] = [];
    for (let t: Node | null = root; t; t = t.children.find(c => !isEnd(c)) || null) list.push(t);
    return list;
}

/** Chóp của đốt cuối: con *_end nếu có, không thì chính nó. */
function tip(last: Node): Node {
    return last.children.find(isEnd) || last;
}

function hasDescendant(root: Node, test: (n: Node) => boolean): boolean {
    for (const c of root.children) if (test(c) || hasDescendant(c, test)) return true;
    return false;
}

/** Không có config: đoán loài theo bone dưới body (Spine nông nhất). */
function detectKind(body: Node): string {
    // cá (kể cả cua ẩn sĩ có chân / càng) có chuỗi thân Spine_2.. / Tail: để Fish.ts lo
    if (hasDescendant(body, n => /^(Spine|Tail)_?0*[2-9]/i.test(n.name) || /^Tail/i.test(n.name))) return '';
    const arms = children(body, 'Arm_');
    if (arms.some(a => child(a, 'Claw')) || children(body, 'Leg_').length > 0) return 'CrabProceduralAnimator';
    if (child(body, 'Head') && arms.length >= 3) return 'OctopusProceduralAnimator';
    if (!child(body, 'Head') && arms.length >= 4) return 'StarfishProceduralAnimator';
    // cá ngựa / hải cẩu dùng rig cá chuẩn (Spine_1..3, Tail_*) nên không đoán được - cần FishAnimConfig
    return '';
}

/** Tham số mặc định (theo code Unity) ghi đè bằng field cùng tên trong prefab. */
function withParams<T extends Record<string, number>>(defaults: T, params: Record<string, number>): T {
    const out = { ...defaults };
    for (const k of Object.keys(defaults)) if (typeof params[k] === 'number') (out as Record<string, number>)[k] = params[k];
    return out;
}

/** Tham số chung của lớp cha FishProceduralAnimator lấy từ prefab. */
const BASE_KEYS = ['turnBend', 'pitchBend', 'bendDelay', 'bendSmoothing', 'maxBendPerBone', 'idleSpeed', 'swimSpeed', 'blendSmoothing'];
function baseParams(params: Record<string, number>): Partial<CreatureParams> {
    const out: Record<string, number> = {};
    for (const k of BASE_KEYS) if (typeof params[k] === 'number') out[k] = params[k];
    return out as Partial<CreatureParams>;
}

// scratch
const _v = new Vec3();
const _qInv = new Quat();
const _qA = new Quat();
const _qB = new Quat();
const _qR = new Quat();
const _up = new Vec3();
const _fwd = new Vec3();
const _lat = new Vec3();
const _axisW = new Vec3();
const _v2 = new Vec3();
const UP = new Vec3(0, 1, 0);
const FWD = new Vec3(0, 0, 1);
const RIGHT = new Vec3(1, 0, 0);

export class CreatureAnimator {
    readonly kind: string;
    private readonly root: Node;
    private readonly bones: WaveBone[] = [];
    private readonly p: CreatureParams;

    private clock = 0;
    private bodyPhase = 0;
    private finPhase = 0;
    private idleBlend = 0;
    private hasPrev = false;
    private prevRot = new Quat();
    private yawRate = 0;
    private pitchRate = 0;
    private rollRate = 0;
    private hHead = 0;
    private hT = new Float32Array(HIST);
    private hYaw = new Float32Array(HIST);
    private hPitch = new Float32Array(HIST);
    private hRoll = new Float32Array(HIST);

    constructor(kind: string, root: Node, p: Partial<CreatureParams>) {
        this.kind = kind;
        this.root = root;
        // mặc định lớp cha FishProceduralAnimator
        this.p = Object.assign({
            swayFrequency: 1, swimSwayFrequency: 0, finFrequency: 1, swimFinFrequency: 0, finFold: 0, tailSign: -1,
            steadyRhythm: false, waveK: 0,
            idleSpeed: 0.6, swimSpeed: 1, blendSmoothing: 4,
            turnBend: 7, pitchBend: 5, bendDelay: 0.3, bendSmoothing: 10, maxBendPerBone: 14,
        }, p);
        this.p.swimSpeed = Math.max(this.p.swimSpeed, this.p.idleSpeed + 0.01);
    }

    /**
     * Animator cho rig bạch tuộc / cua dưới root (node gắn Fish); không phải thì null (Fish dùng sóng thân cá).
     * Có config (bake từ prefab Unity): chọn theo tên class animator và lấy tham số trong prefab; không có thì đoán theo bone.
     */
    static tryCreate(root: Node, config?: FishAnimConfig | null): CreatureAnimator | null {
        const body = findShallowest(root, 'Spine');
        if (!body) return null;
        const params = config ? config.params : {};
        const kind = config && config.animator ? config.animator : detectKind(body);
        switch (kind) {
            case 'OctopusProceduralAnimator': return buildOctopus(root, body, params);
            case 'CrabProceduralAnimator': return buildCrab(root, body, params);
            case 'StarfishProceduralAnimator': return buildStarfish(root, body, params);
            case 'SeahorseProceduralAnimator': return buildSeahorse(root, params);
            case 'SealProceduralAnimator': return buildSeal(root, params);
            default: return null; // FishRig / Fishdom / loài chưa port: Fish.ts (sóng thân cá)
        }
    }

    get boneCount(): number { return this.bones.length; }

    /** Vị trí root space của node. */
    local(n: Node, out = new Vec3()): Vec3 {
        return this.root.inverseTransformPoint(out, Vec3.clone(n.worldPosition));
    }

    /** Hướng đơn vị root space a -> b, fallback khi trùng chỗ. */
    dir(a: Node, b: Node, fallback: Vec3): Vec3 {
        const d = Vec3.subtract(new Vec3(), this.local(b), this.local(a));
        return Vec3.lengthSqr(d) > 1e-8 ? d.normalize() : fallback.clone();
    }

    register(node: Node, init: WaveInit): void {
        const d: WaveBone = {
            node, bindLocal: node.rotation.clone(), bindScale: node.scale.clone(),
            sideFin: false, along: 0, axis: 0, finAxis: new Vec3(1, 0, 0),
            twistAmp: 0, side: 1, foldScale: 0, pitchBias: 0, idlePitchBias: 0,
            amp: 0, bias: 0, lag: 0, skew: 0, sharpen: 0, scaleAmp: new Vec3(),
            idleVariant: false, idleAmp: 0, idleBias: 0, idleLag: 0, idleSkew: 0, idleSharpen: 0, idleScaleAmp: new Vec3(),
            bendScale: 0, pitchBend: false, rollBend: 0, hasScale: false,
        };
        Object.assign(d, init);
        if (!d.idleVariant) {
            // không có bộ idle riêng: idle = bơi (Rebake của lớp cha)
            d.idleAmp = d.amp; d.idleBias = d.bias; d.idleLag = d.lag;
            d.idleSkew = d.skew; d.idleSharpen = d.sharpen; d.idleScaleAmp = d.scaleAmp.clone();
            d.idlePitchBias = d.pitchBias;
        }
        d.hasScale = !Vec3.equals(d.scaleAmp, Vec3.ZERO) || !Vec3.equals(d.idleScaleAmp, Vec3.ZERO);
        this.bones.push(d);
    }

    /** Sau khi đăng ký hết bone: cha trước con, đặt pha ban đầu theo timeOffset. */
    finish(timeOffset: number, speed: number): void {
        const depth = (n: Node) => { let k = 0; for (let t = n.parent; t; t = t.parent) k++; return k; };
        this.bones.sort((a, b) => depth(a.node) - depth(b.node));
        this.bodyPhase = timeOffset * this.p.swayFrequency * Math.PI * 2;
        this.finPhase = timeOffset * this.p.finFrequency * Math.PI * 2;
        this.idleBlend = this.blendTarget(speed); // bắt đầu đúng chế độ hiện tại, không ramp
    }

    resetPose(): void {
        for (const b of this.bones) {
            if (!b.node || !b.node.isValid) continue;
            b.node.rotation = b.bindLocal;
            if (b.hasScale) b.node.scale = b.bindScale;
        }
    }

    private blendTarget(speed: number): number {
        return clamp01((speed - this.p.idleSpeed) / Math.max(this.p.swimSpeed - this.p.idleSpeed, 1e-3));
    }

    /** Một frame: đo tốc độ góc root, tích luỹ pha + blend idle/bơi rồi đặt pose (FishPoseJob.Execute, nhánh Wave). */
    step(dt: number, speed: number): void {
        if (dt <= 0) return;
        const p = this.p;
        this.clock += dt;
        this.measureTurn(dt);
        const target = this.blendTarget(speed);
        this.idleBlend = p.blendSmoothing > 0
            ? this.idleBlend + (target - this.idleBlend) * (1 - Math.exp(-p.blendSmoothing * dt))
            : target;
        const w = this.idleBlend;
        const steady = p.steadyRhythm ? w : 0;
        const swimSway = p.swimSwayFrequency > 0 ? p.swimSwayFrequency : p.swayFrequency;
        const swimFin = p.swimFinFrequency > 0 ? p.swimFinFrequency : p.finFrequency;
        this.bodyPhase += dt * lerp(p.swayFrequency * speed, swimSway, steady) * Math.PI * 2;
        this.finPhase += dt * lerp(p.finFrequency * (0.7 + 0.3 * speed), swimFin, steady) * Math.PI * 2;
        this.applyPose(w, speed);
    }

    private applyPose(w: number, speed: number): void {
        const p = this.p;
        const rootRot = this.root.worldRotation;
        Vec3.transformQuat(_up, UP, rootRot);
        Vec3.transformQuat(_fwd, FWD, rootRot);
        Vec3.transformQuat(_lat, RIGHT, rootRot);
        const s = Math.max(speed, 0.05);
        const steadyAmp = p.steadyRhythm ? w : 0;
        const ampScale = lerp(Math.sqrt(s), 1, steadyAmp);                        // nhịp ổn định: bơi biên độ = tham số
        const finAmp = lerp(clamp(1.4 - 0.5 * s, 0.4, 1.4), 1, steadyAmp);        // cá: bơi chậm vây vẫy nhiều, nhanh thì giữ yên
        const fold = p.finFold * clamp01(s - 1);

        for (const b of this.bones) {
            const parent = b.node.parent;
            if (!parent) continue;
            const wb = b.idleVariant ? w : 1;
            const amp = lerp(b.idleAmp, b.amp, wb);
            const lag = lerp(b.idleLag, b.lag, wb);
            const bias = lerp(b.idleBias, b.bias, wb);
            const skew = lerp(b.idleSkew, b.skew, wb);
            const sharpen = lerp(b.idleSharpen, b.sharpen, wb);
            const pitchBias = lerp(b.idlePitchBias, b.pitchBias, wb);

            if (b.axis === 0) Vec3.copy(_axisW, _up);
            else if (b.axis === 1) Vec3.copy(_axisW, _fwd);
            else Vec3.transformQuat(_axisW, b.finAxis, rootRot);

            let pulse: number;
            if (b.sideFin) {
                // vây bên: quét quanh Axis + xoắn quanh trục gốc -> chóp lệch pha 90°, gập về phía đuôi khi bơi nhanh
                let ph = this.finPhase - lag;
                ph += skew * Math.sin(ph);
                pulse = Math.sin(ph);
                const sweep = amp * finAmp * pulse;
                const twist = b.twistAmp * finAmp * Math.cos(ph);
                const sweepSigned = b.side * (sweep + bias - p.tailSign * fold * b.foldScale);
                Vec3.transformQuat(_v2, b.finAxis, rootRot);
                CreatureAnimator.rotateAbout(parent, _axisW, sweepSigned, _qR);
                Quat.multiply(_qR, _qR, CreatureAnimator.rotateAbout(parent, _v2, twist, _qA));
            } else {
                const ph = this.bodyPhase - p.waveK * b.along - lag;
                pulse = Math.sin(ph + skew * Math.sin(ph));
                if (sharpen > 0) { // ép về dạng vuông mượt: giữ ở hai đầu, chuyển nhanh
                    const k = sharpen * 6;
                    pulse = Math.tanh(k * pulse) / Math.tanh(k);
                }
                const a = bias + amp * ampScale * pulse;

                let by = 0, bp = 0, br = 0;
                if (b.bendScale > 0 || b.rollBend > 0) [by, bp, br] = this.getTurnBend(b.along, b.bendScale, b.rollBend);

                CreatureAnimator.rotateAbout(parent, _axisW, a + by, _qR);
                if (b.pitchBend || pitchBias !== 0) Quat.multiply(_qR, _qR, CreatureAnimator.rotateAbout(parent, _lat, bp + pitchBias, _qA));
                if (b.rollBend > 0) Quat.multiply(_qR, _qR, CreatureAnimator.rotateAbout(parent, _fwd, br, _qA));
            }

            Quat.multiply(_qB, _qR, b.bindLocal);
            b.node.rotation = _qB;

            if (b.hasScale) {
                const sx = lerp(b.idleScaleAmp.x, b.scaleAmp.x, wb);
                const sy = lerp(b.idleScaleAmp.y, b.scaleAmp.y, wb);
                const sz = lerp(b.idleScaleAmp.z, b.scaleAmp.z, wb);
                b.node.setScale(b.bindScale.x * (1 + sx * pulse), b.bindScale.y * (1 + sy * pulse), b.bindScale.z * (1 + sz * pulse));
            }
        }
    }

    /** Quaternion xoay `degrees` quanh trục worldAxis, biểu diễn trong parent space. */
    private static rotateAbout(parent: Node, worldAxis: Vec3, degrees: number, out: Quat): Quat {
        Quat.invert(_qInv, parent.worldRotation);
        Vec3.transformQuat(_v, worldAxis, _qInv);
        if (Vec3.lengthSqr(_v) < 1e-12) return Quat.identity(out);
        _v.normalize();
        return Quat.fromAxisAngle(out, _v, degrees * DEG2RAD);
    }

    // ---------- Uốn theo đường bơi ----------

    /** Tốc độ góc của root trong local space frame trước: yaw quanh Y, pitch quanh X, roll quanh Z; lọc rồi ghi lịch sử. */
    private measureTurn(dt: number): void {
        const rot = this.root.worldRotation;
        if (this.hasPrev) {
            Quat.conjugate(_qA, this.prevRot);
            Quat.multiply(_qB, _qA, rot);
            let ang = Quat.getAxisAngle(_v, _qB) * RAD2DEG;
            if (ang > 180) ang -= 360;
            const k = 1 - Math.exp(-this.p.bendSmoothing * dt);
            this.yawRate += (ang * _v.y / dt - this.yawRate) * k;
            this.pitchRate += (ang * _v.x / dt - this.pitchRate) * k;
            this.rollRate += (ang * _v.z / dt - this.rollRate) * k;
        }
        Quat.copy(this.prevRot, rot);
        this.hasPrev = true;
        this.hHead = (this.hHead + 1) % HIST;
        this.hT[this.hHead] = this.clock;
        this.hYaw[this.hHead] = this.yawRate;
        this.hPitch[this.hHead] = this.pitchRate;
        this.hRoll[this.hHead] = this.rollRate;
    }

    private getTurnBend(along: number, scale: number, rollScale: number): [number, number, number] {
        const p = this.p;
        const target = this.clock - p.bendDelay * along;
        let yr = 0, pr = 0, rr = 0;
        let i = this.hHead;
        let found = false;
        for (let n = 0; n < HIST - 1; n++) {
            const j = (i - 1 + HIST) % HIST;
            if (this.hT[j] <= target) {
                const span = this.hT[i] - this.hT[j];
                const f = span > 1e-5 ? clamp01((target - this.hT[j]) / span) : 1;
                yr = lerp(this.hYaw[j], this.hYaw[i], f);
                pr = lerp(this.hPitch[j], this.hPitch[i], f);
                rr = lerp(this.hRoll[j], this.hRoll[i], f);
                found = true;
                break;
            }
            i = j;
        }
        if (!found) { yr = this.hYaw[i]; pr = this.hPitch[i]; rr = this.hRoll[i]; }
        const m = p.maxBendPerBone;
        return [
            clamp(-p.turnBend * yr / 90 * scale, -m, m),
            clamp(-p.pitchBend * pr / 90 * scale, -m, m),
            clamp(-p.turnBend * rr / 90 * rollScale, -m, m),
        ];
    }
}

// ---------- Bạch tuộc (OctopusProceduralAnimator) ----------

/**
 * Root > Spine_1 > Head_1 > Head_2 (mantle); 8 tay là con của Spine_1, mỗi tay 2 đốt (Arm_<đốt>_F/_B, Arm_<tay>_<đốt>_L/_R),
 * xếp thành vòng dưới thân, bind pose xòe ngang.
 * Idle (Speed ≤ 0.6): tay rủ nhẹ đung đưa, lệch pha nhẹ quanh vòng, mantle thở, nhịp 0.7 Hz × Speed;
 * bơi (Speed ≥ 1): cùng dạng, nhịp ổn định 0.55 Hz, góc nghỉ / biên độ nhỉnh hơn, mantle vươn nhẹ; blend mượt ~0.25 s.
 */
const OCTOPUS = {
    pulseFrequency: 0.7, swimFrequency: 0.55,
    bodySway: 2, mantleNod: 1.3, mantleNodIdle: 1, mantleLag: 0.3, mantleStretch: 0.08, mantleBreath: 0.06, mantleBend: 0.5,
    armBias: 33, armSweep: 28, armTipBias: 11, armTipSweep: 9, armLag: 0.5, armSkew: 0.3, armSharpen: 0.2,
    armBend: 0.3, armRollBend: 0.6, armTipRollBend: 0.8, mantleRollBend: 0.3,
    armIdleBias: 30, armIdleSway: 30, armIdleTipBias: 10, armIdleTipSway: 10, armIdleLag: 0.5, armIdleSkew: 0.25, armIdleSharpen: 0.15,
    ringWave: 0.3,
};

function buildOctopus(root: Node, body: Node, params: Record<string, number>): CreatureAnimator {
    const o = withParams(OCTOPUS, params);
    const a = new CreatureAnimator('octopus', root, {
        ...baseParams(params),
        swayFrequency: o.pulseFrequency, waveK: 0, steadyRhythm: true, swimSwayFrequency: o.swimFrequency,
    });

    a.register(body, { amp: o.bodySway, bendScale: 1, pitchBend: true, axis: 0 });

    const mantle = chain(child(body, 'Head'));
    const side = -0.6; // bóp ngang khi vươn dọc
    mantle.forEach((n, i) => {
        const r = i === 0; // chỉ scale đốt gốc: đốt trên là con nên kế thừa
        a.register(n, {
            amp: o.mantleNod, lag: i * o.mantleLag, skew: o.armSkew, sharpen: o.armSharpen,
            bendScale: o.mantleBend, axis: 2, finAxis: new Vec3(1, 0, 0), rollBend: o.mantleRollBend,
            scaleAmp: r ? new Vec3(side * o.mantleStretch, o.mantleStretch, side * o.mantleStretch) : new Vec3(),
            idleVariant: true, idleAmp: o.mantleNodIdle, idleLag: i * o.mantleLag, idleBias: 0,
            idleScaleAmp: r ? new Vec3(side * o.mantleBreath, o.mantleBreath, side * o.mantleBreath) : new Vec3(),
            idleSkew: o.armIdleSkew, idleSharpen: o.armIdleSharpen,
        });
    });

    const center = a.local(body);
    for (const armRoot of children(body, 'Arm_')) {
        const segs = chain(armRoot);
        const radial = Vec3.subtract(new Vec3(), a.local(segs[0]), center);
        radial.y = 0;
        if (Vec3.lengthSqr(radial) < 1e-8) { Vec3.subtract(radial, a.local(tip(segs[segs.length - 1])), center); radial.y = 0; }
        if (Vec3.lengthSqr(radial) < 1e-8) radial.set(0, 0, 1);
        radial.normalize();
        const angle = Math.atan2(radial.x, radial.z);                         // góc quanh vòng, 0 = +Z
        const axis = Vec3.cross(new Vec3(), UP, radial).normalize();          // quay dương = hạ đầu tay xuống
        segs.forEach((n, i) => {
            const r = i === 0;
            a.register(n, {
                along: 0.5, axis: 2, finAxis: axis, bendScale: o.armBend, rollBend: r ? o.armRollBend : o.armTipRollBend,
                amp: r ? o.armSweep : o.armTipSweep, bias: r ? o.armBias : o.armTipBias,
                lag: i * o.armLag + o.ringWave * angle, skew: o.armSkew, sharpen: o.armSharpen,
                idleVariant: true, idleAmp: r ? o.armIdleSway : o.armIdleTipSway, idleBias: r ? o.armIdleBias : o.armIdleTipBias,
                idleLag: i * o.armIdleLag + o.ringWave * angle, idleSkew: o.armIdleSkew, idleSharpen: o.armIdleSharpen,
            });
        });
    }
    return a;
}

// ---------- Cua (CrabProceduralAnimator) ----------

/**
 * Root > Spine_1 > Head; Eye_1_<L|R> > Eye_2 (cuống mắt); Arm_<L|R> > Claw > ClawUpper_1..2 / ClawLower_1..2 (càng);
 * Leg_1_<F|B>_<L|R> > Leg_2 > Leg_3 (4 chân 3 đốt; chóp chân sau trùng tên nên duyệt theo cây).
 * Thân lắc + nghiêng theo hướng rẽ, đầu gật; cuống mắt nghiêng ngược chiều nhau; càng nhấc lên xuống, hai bên ngược pha,
 * càng trên / dưới mở khép; chân đạp, đốt sau trễ pha, trước / sau ngược pha, trái / phải lệch 1/4 chu kỳ. Nhịp 1.6 Hz × Speed.
 */
const CRAB = {
    kickFrequency: 1.6, bodySway: 2, headNod: 2, eyeWobble: 5, eyeLag: 0.7,
    armLift: 6, clawOpen: 10, clawLag: 0.6,
    legKick: 12, legLag: 0.7, legSidePhase: Math.PI * 0.5, legFrontBackPhase: Math.PI, legBend: 0.2,
};

/** Dấu bên theo x root space (+1 phải, -1 trái); |x| quá nhỏ thì theo tên, cuối cùng +1. */
function sideSign(pos: Vec3, named: number): number {
    if (Math.abs(pos.x) > 1e-4) return pos.x >= 0 ? 1 : -1;
    return named !== 0 ? Math.sign(named) : 1;
}

/** Trục vuông góc dir và nằm ngang: xoay quanh nó = vung chi lên xuống. */
function swingAxis(dir: Vec3, fallback: Vec3): Vec3 {
    const a = Vec3.cross(new Vec3(), UP, dir);
    return Vec3.lengthSqr(a) > 1e-8 ? a.normalize() : fallback.clone();
}

function buildCrab(root: Node, body: Node, params: Record<string, number>): CreatureAnimator {
    const c = withParams(CRAB, params);
    const a = new CreatureAnimator('crab', root, { ...baseParams(params), swayFrequency: c.kickFrequency, waveK: 0 });

    a.register(body, { amp: c.bodySway, bendScale: 1, pitchBend: true, axis: 0 });
    const head = child(body, 'Head');
    if (head) a.register(head, { amp: c.headNod, bendScale: 0.3, axis: 2, finAxis: new Vec3(1, 0, 0) });

    for (const eyeRoot of children(body, 'Eye_')) {
        const segs = chain(eyeRoot);
        const side = sideSign(a.local(segs[0]), sideFromName(eyeRoot));
        segs.forEach((n, i) => a.register(n, { amp: c.eyeWobble * side * (i === 0 ? 1 : 0.7), lag: i * c.eyeLag, axis: 1 }));
    }

    for (const arm of children(body, 'Arm_')) {
        const side = sideSign(a.local(arm), sideFromName(arm));
        const claw = child(arm, 'Claw');
        const upper = chain(child(claw, 'ClawUpper'));
        const lower = chain(child(claw, 'ClawLower'));
        const reach = claw || upper[0] || null;
        const armDir = reach ? a.dir(arm, reach, FWD) : FWD.clone();
        const liftAxis = swingAxis(armDir, RIGHT);
        const armLag = side < 0 ? 0 : Math.PI; // hai bên ngược pha
        a.register(arm, { amp: c.armLift, lag: armLag, bendScale: 0.3, axis: 2, finAxis: liftAxis });
        if (claw) a.register(claw, { amp: c.armLift * 0.5, lag: 0.5 + armLag, bendScale: 0.3, axis: 2, finAxis: liftAxis });

        const pivot = claw || arm;
        let hinge = RIGHT.clone();
        if (upper.length && lower.length) {
            const h = Vec3.cross(new Vec3(), a.dir(pivot, upper[0], FWD), a.dir(pivot, lower[0], FWD));
            if (Vec3.lengthSqr(h) > 1e-8) hinge = h.normalize();
        }
        const clawLagSide = side < 0 ? 0 : Math.PI * 0.5;
        upper.forEach((n, i) => a.register(n, { amp: c.clawOpen * (i === 0 ? 1 : 0.5), lag: i * c.clawLag + clawLagSide, axis: 2, finAxis: hinge }));
        lower.forEach((n, i) => a.register(n, { amp: -c.clawOpen * (i === 0 ? 1 : 0.5), lag: i * c.clawLag + clawLagSide, axis: 2, finAxis: hinge }));
    }

    for (const legRoot of children(body, 'Leg_')) {
        const segs = chain(legRoot);
        const rootPos = a.local(segs[0]);
        const side = sideSign(rootPos, sideFromName(legRoot));
        const front = nameHas(legRoot, '_F_');
        const next = segs.length > 1 ? segs[1] : tip(segs[segs.length - 1]);
        const legDir = a.dir(segs[0], next, new Vec3(side, 0, 0));
        const kickAxis = swingAxis(legDir, FWD);
        segs.forEach((n, i) => a.register(n, {
            along: 0.5, amp: c.legKick * Math.max(0.2, 1 - 0.2 * i),
            lag: i * c.legLag + (front ? 0 : c.legFrontBackPhase) + (side < 0 ? 0 : c.legSidePhase),
            bendScale: c.legBend, axis: 2, finAxis: kickAxis,
        }));
    }
    return a;
}

// ---------- Sao biển (StarfishProceduralAnimator) ----------

/**
 * Root > Spine_1 (tâm sao) > 5 tay Arm_*, mỗi tay 2 đốt; sao phẳng trong mặt XY root space, mặt sao hướng +Z.
 * Thân lắc quanh pháp tuyến mặt sao; mỗi tay uốn trong mặt sao (quanh trục dọc +Z), đốt chóp trễ pha, các tay lệch pha theo góc
 * quanh sao (ringWave) -> gợn sóng chạy vòng quanh sao. Idle 1 Hz × Speed; bơi nhịp ổn định 0.6 Hz.
 */
const STARFISH = {
    waveFrequency: 1, bodyRock: 3,
    armAngle: 6, armTipAngle: 8, armLag: 0.9, ringWave: 1,
    swimFrequency: 0.6, swimArmAngle: 6, swimArmTipAngle: 10,
};

function buildStarfish(root: Node, body: Node, params: Record<string, number>): CreatureAnimator {
    const s = withParams(STARFISH, params);
    const a = new CreatureAnimator('starfish', root, {
        ...baseParams(params),
        swayFrequency: s.waveFrequency, finFrequency: s.waveFrequency, waveK: 0, steadyRhythm: true,
        swimSwayFrequency: s.swimFrequency, swimFinFrequency: s.swimFrequency,
    });
    a.register(body, { amp: s.bodyRock, bendScale: 1, pitchBend: true, axis: 1 });
    const center = a.local(body);
    for (const armRoot of children(body, 'Arm_')) {
        const segs = chain(armRoot);
        const radial = Vec3.subtract(new Vec3(), a.local(segs[0]), center);
        radial.z = 0;
        if (Vec3.lengthSqr(radial) < 1e-8) { Vec3.subtract(radial, a.local(tip(segs[segs.length - 1])), center); radial.z = 0; }
        if (Vec3.lengthSqr(radial) < 1e-8) radial.set(0, 1, 0);
        const angle = Math.atan2(radial.x, radial.y);                 // góc quanh tâm sao, 0 = +Y
        segs.forEach((n, i) => {
            const r = i === 0;
            const lag = i * s.armLag + s.ringWave * angle;
            a.register(n, {
                along: 0.5, axis: 1, bendScale: 0, pitchBend: false,  // mặt luôn về camera nên không uốn theo rẽ hướng
                amp: r ? s.swimArmAngle : s.swimArmTipAngle, lag,
                idleVariant: true, idleAmp: r ? s.armAngle : s.armTipAngle, idleLag: lag,
            });
        });
    }
    return a;
}

// ---------- Rig cá chuẩn (FishRigProceduralAnimator) cho cá ngựa / hải cẩu ----------

enum RigFin { Pectoral, Pelvic, Dorsal, Anal }

interface RigBone {
    node: Node;
    kind: 'body' | 'head' | 'sidefin' | 'centerfin';
    role: RigFin;
    along: number;
    chain: number;
    side: number;
    tipSign: number;
    finAxis: Vec3;
}

/** Hook đổi hướng thân như class con của FishRigProceduralAnimator (cá ngựa đứng dọc). */
interface RigHooks {
    alongCoord: (p: Vec3) => number;    // tọa độ dọc thân từ vị trí root space (mặc định z)
    bodyAxis: number;                   // trục sóng thân / đầu: 0 = up, 1 = dọc thân, 2 = bodyWaveAxis
    bodyWaveAxis: Vec3;
    centerFinAxis: number;              // trục nghiêng vây lưng / hậu môn: 1 = dọc thân (cá nằm ngang), 0 = up (cá đứng)
}

const FISHRIG = {
    swayFrequency: 1.8, swayAngle: 12, waveLength: 2, headSway: 2,
    finFrequency: 2.2, finAngle: 14, finTwist: 18, finChainAngle: 6, finChainLag: 0.9, finPhaseOffset: Math.PI, finFold: 20,
    pelvicAngle: 6, pelvicTwist: 8, pelvicPhaseOffset: 1.2,
    centerFinAngle: 5, centerFinChainLag: 0.6,
};

const RIG_BODY_RE = /^(Spine|Tail)_?(\d+)$/i;
const RIG_FIN_RES: [RegExp, (m: RegExpExecArray) => [string, number]][] = [
    [/^Fin_([TBM])_([FBLRM])_(\d+)$/i, m => [m[1] + '_' + m[2], +m[3]]],   // Fin_M_L_1
    [/^Fin_([TBM])_(\d+)_([FBLRM])$/i, m => [m[1] + '_' + m[3], +m[2]]],   // Fin_M_01_L
    [/^Fin_(\d+)_([TBM])_([FBLRM])$/i, m => [m[2] + '_' + m[3], +m[1]]],   // Fin_1_M_L (SK_Fish*)
    [/^Fin_(\d+)_([TB])$/i, m => [m[2] + '_M', +m[1]]],                     // Fin_01_B: vây giữa
];

/** Find Bones + OnBuild của FishRigProceduralAnimator: chuỗi thân Spine..Tail, Head, các vây theo quy ước tên. */
function collectFishRig(a: CreatureAnimator, root: Node, hooks: RigHooks): { bones: RigBone[]; tailSign: number; bodyRoot: Node | null } {
    const spines: [number, Node][] = [];
    const tails: [number, Node][] = [];
    const finGroups = new Map<string, [number, Node][]>();
    let head: Node | null = null;
    const walk = (n: Node) => {
        for (const c of n.children) {
            walk(c);
            if (isEnd(c)) continue;
            const m = RIG_BODY_RE.exec(c.name);
            if (m) { (m[1].toLowerCase() === 'spine' ? spines : tails).push([+m[2], c]); continue; }
            if (c.name.toLowerCase() === 'head') { head = c; continue; }
            for (const [re, fn] of RIG_FIN_RES) {
                const f = re.exec(c.name);
                if (!f) continue;
                const [key, idx] = fn(f);
                const k = key.toUpperCase();
                if (!finGroups.has(k)) finGroups.set(k, []);
                finGroups.get(k)!.push([idx, c]);
                break;
            }
        }
    };
    walk(root);
    spines.sort((x, y) => x[0] - y[0]);
    tails.sort((x, y) => x[0] - y[0]);
    const body = [...spines, ...tails].map(x => x[1]);
    const out: RigBone[] = [];
    if (!body.length) return { bones: out, tailSign: -1, bodyRoot: null };

    const coord = (n: Node) => hooks.alongCoord(a.local(n));
    const last = body[body.length - 1];
    const zStart = coord(body[0]);
    let zTip = coord(last.children.length ? last.children[0] : last);
    const tailSign = zTip >= zStart ? 1 : -1;
    if (Math.abs(zTip - zStart) < 1e-5) zTip = zStart - 1e-5;
    const alongOf = (n: Node) => clamp01((coord(n) - zStart) / (zTip - zStart));
    const base = { role: RigFin.Dorsal, chain: 0, side: 0, tipSign: 1, finAxis: new Vec3() };

    for (const n of body) out.push({ ...base, node: n, kind: 'body', along: alongOf(n) });
    if (head) out.push({ ...base, node: head, kind: 'head', along: alongOf(head) });

    for (const key of Array.from(finGroups.keys()).sort()) {
        const pos = key[0], sd = key[2];
        const sideName = sd === 'L' ? -1 : sd === 'R' ? 1 : 0;
        let role: RigFin;
        if (pos === 'M') { if (!sideName) continue; role = RigFin.Pectoral; }
        else if (pos === 'B') role = sideName ? RigFin.Pelvic : RigFin.Anal;
        else if (pos === 'T') role = RigFin.Dorsal;
        else continue;
        const segs = finGroups.get(key)!.sort((x, y) => x[0] - y[0]).map(x => x[1]);
        const sideFin = role === RigFin.Pectoral || role === RigFin.Pelvic;
        const rootPos = a.local(segs[0]);
        const lastSeg = segs[segs.length - 1];
        const tipPos = a.local(lastSeg.children.length ? lastSeg.children[0] : lastSeg);
        const side = sideName !== 0 ? sideName : (rootPos.x >= 0 ? 1 : -1);
        const axis = Vec3.subtract(new Vec3(), tipPos, rootPos);
        if (Vec3.lengthSqr(axis) < 1e-8) axis.set(sideFin ? side : 0, sideFin ? 0 : 1, 0);
        axis.normalize();
        const tipSign = axis.y >= 0 ? 1 : -1;
        segs.forEach((n, i) => out.push({ node: n, kind: sideFin ? 'sidefin' : 'centerfin', role, along: alongOf(n), chain: i, side, tipSign, finAxis: axis.clone() }));
    }
    return { bones: out, tailSign, bodyRoot: body[0] };
}

/** BakeBone của FishRigProceduralAnimator (hình học chung; class con đặt lại biên độ / dạng). */
function bakeFishRig(b: RigBone, f: typeof FISHRIG, hooks: RigHooks): WaveInit {
    switch (b.kind) {
        case 'head':
            return { along: b.along, amp: -f.headSway, lag: 0, bendScale: 0, pitchBend: false, axis: hooks.bodyAxis, finAxis: hooks.bodyWaveAxis.clone() };
        case 'sidefin': {
            const pectoral = b.role === RigFin.Pectoral;
            const rootAngle = pectoral ? f.finAngle : f.pelvicAngle;
            const chainAngle = pectoral ? f.finChainAngle : f.pelvicAngle * 0.5;
            const twistAngle = pectoral ? f.finTwist : f.pelvicTwist;
            return {
                sideFin: true, along: b.along, amp: b.chain === 0 ? rootAngle : chainAngle, twistAmp: twistAngle * (b.chain === 0 ? 1 : 0.5),
                lag: b.chain * f.finChainLag - (b.side < 0 ? f.finPhaseOffset : 0) - (pectoral ? 0 : f.pelvicPhaseOffset),
                side: b.side, foldScale: pectoral ? 1 : 0.5, axis: 0, finAxis: b.finAxis.clone(),
            };
        }
        case 'centerfin':
            return {
                along: b.along, amp: f.centerFinAngle * (b.chain === 0 ? 1 : 0.7) * b.tipSign, lag: (b.chain + 1) * f.centerFinChainLag,
                bendScale: 0, pitchBend: false, axis: hooks.centerFinAxis,
            };
        default: // body (biên độ swayAngle × swayProfile: cá ngựa / hải cẩu đều đặt lại)
            return { along: b.along, amp: f.swayAngle * b.along, lag: 0, bendScale: lerp(0.6, 1.2, b.along), pitchBend: true, axis: hooks.bodyAxis, finAxis: hooks.bodyWaveAxis.clone() };
    }
}

function fishRigParams(f: typeof FISHRIG, tailSign: number): Partial<CreatureParams> {
    return { swayFrequency: f.swayFrequency, finFrequency: f.finFrequency, waveK: Math.PI * 2 / Math.max(f.waveLength, 0.05), finFold: f.finFold, tailSign };
}

// ---------- Cá ngựa (SeahorseProceduralAnimator) ----------

/**
 * Rig cá chuẩn nhưng đứng dọc: đầu +Y, đuôi cuộn xuống -Y, mặt / bụng +Z. Thân gần cứng cuộn chậm quanh trục ngang (bodyCurl × vị trí dọc
 * thân), bơi thì ngả về trước leanForward; vây lưng (T_B) quét sang hai bên theo nhịp vây nhanh, mào đầu (T_F) đứng yên; vây ngực / bụng rung
 * nhỏ, không gập; vây hậu môn nghiêng nhẹ. Idle: thân 0.6 Hz × Speed, vây 2.5 Hz; bơi nhịp ổn định thân 0.3 Hz, vây 3 Hz.
 */
const SEAHORSE = {
    idleBodyFrequency: 0.6, idleFinFrequency: 2.5, swimBodyFrequency: 0.3, swimFinFrequency: 3,
    bodyCurl: 4, headNod: 1, leanForward: 10,
    dorsalFlutter: 8, dorsalChainLag: 1.2, pectoralFlutter: 5, pectoralTwist: 4, pelvicFlutter: 4, analTilt: 2,
};

function buildSeahorse(root: Node, params: Record<string, number>): CreatureAnimator | null {
    const f = withParams(FISHRIG, params);
    const s = withParams(SEAHORSE, params);
    const hooks: RigHooks = { alongCoord: p => -p.y, bodyAxis: 2, bodyWaveAxis: new Vec3(1, 0, 0), centerFinAxis: 0 };
    const probe = new CreatureAnimator('seahorse', root, {});
    const rig = collectFishRig(probe, root, hooks);
    if (!rig.bones.length) return null;
    const a = new CreatureAnimator('seahorse', root, {
        ...baseParams(params), ...fishRigParams(f, rig.tailSign),
        swayFrequency: s.idleBodyFrequency, finFrequency: s.idleFinFrequency, finFold: 0, steadyRhythm: true,
        swimSwayFrequency: s.swimBodyFrequency, swimFinFrequency: s.swimFinFrequency,
    });
    for (const b of rig.bones) {
        const d = bakeFishRig(b, f, hooks);
        const k = b.chain === 0;
        if (b.kind === 'body') {
            d.amp = s.bodyCurl * b.along;
            if (b.node === rig.bodyRoot) Object.assign(d, { bias: s.leanForward, idleVariant: true, idleAmp: d.amp, idleBias: 0, idleLag: d.lag });
        } else if (b.kind === 'head') {
            d.amp = -s.headNod;
        } else if (b.role === RigFin.Dorsal) {
            if (b.node.name.indexOf('_T_F') >= 0) d.amp = 0;                         // mào trên đầu: đứng yên
            else Object.assign(d, {
                sideFin: true, amp: s.dorsalFlutter * (k ? 1 : 0.7), twistAmp: 0, lag: b.chain * s.dorsalChainLag,
                side: 1, foldScale: 0, axis: 0, finAxis: b.finAxis.clone(), bendScale: 0, pitchBend: false,
            });
        } else if (b.role === RigFin.Pectoral) {
            Object.assign(d, { amp: s.pectoralFlutter * (k ? 1 : 0.5), twistAmp: s.pectoralTwist * (k ? 1 : 0.5), foldScale: 0 });
        } else if (b.role === RigFin.Pelvic) {
            Object.assign(d, { amp: s.pelvicFlutter * (k ? 1 : 0.5), twistAmp: s.pelvicFlutter * 0.5, foldScale: 0 });
        } else { // Anal
            d.amp = (Math.sign(d.amp || 1)) * s.analTilt * (k ? 1 : 0.7);
        }
        a.register(b.node, d);
    }
    return a;
}

// ---------- Hải cẩu (SealProceduralAnimator) ----------

/**
 * Rig cá chuẩn, bind ở tư thế ngồi (đầu cao phía trước +Z, thân xuống và ra sau tới đuôi chẻ). Idle: ngồi như bind, đuôi đung đưa chậm,
 * vây trước phe phẩy. Bơi (nhịp ổn định): duỗi thẳng người thành đường dọc -Y (mỗi đốt thân bù góc lệch của đoạn xương so với phương thẳng
 * đứng - PitchBias × straighten; đầu bù ngược để mặt vẫn +Z), đuôi quạt trong mặt phẳng nhìn thấy (sóng quanh +Z), vây trước ép về sau.
 * Lông bụng / lưng / đỉnh đầu (Fin_B_*, Fin_T_*) đứng yên.
 */
const SEAL = {
    idleBodyFrequency: 0.7, idleFinFrequency: 1.5, swimBodyFrequency: 0.9, swimFinFrequency: 1.5,
    tailSweep: 12, sealHeadSway: 0.5, straighten: 1, pathBend: 0.8,
    flipperFlutter: 5, flipperTwist: 5, flipperTuck: 15,
};

function buildSeal(root: Node, params: Record<string, number>): CreatureAnimator | null {
    const f = withParams(FISHRIG, params);
    const s = withParams(SEAL, params);
    const hooks: RigHooks = { alongCoord: p => p.z, bodyAxis: 1, bodyWaveAxis: new Vec3(1, 0, 0), centerFinAxis: 1 };
    const probe = new CreatureAnimator('seal', root, {});
    const rig = collectFishRig(probe, root, hooks);
    if (!rig.bones.length || !rig.bodyRoot) return null;
    const a = new CreatureAnimator('seal', root, {
        ...baseParams(params), ...fishRigParams(f, rig.tailSign),
        swayFrequency: s.idleBodyFrequency, finFrequency: s.idleFinFrequency, finFold: 0, steadyRhythm: true,
        swimSwayFrequency: s.swimBodyFrequency, swimFinFrequency: s.swimFinFrequency,
    });

    // duỗi thẳng: góc lệch (quanh +X) của từng đoạn thân so với phương thẳng đứng -Y; đốt sau chỉ bù phần còn lại
    const straightBias = new Map<Node, number>();
    let rootTilt = 0;
    let prev = 0;
    let first = true;
    for (let t: Node | null = rig.bodyRoot; t;) {
        const next: Node | null = t.children.find(c => /^(Spine|Tail)/.test(c.name)) || null;
        const d = next ? Vec3.subtract(new Vec3(), a.local(next), a.local(t)) : new Vec3(0, -1, 0);
        const tilt = Vec3.lengthSqr(d) > 1e-8 ? Math.atan2(d.z, -d.y) * RAD2DEG : prev;
        straightBias.set(t, tilt - prev);
        if (first) { rootTilt = tilt; first = false; }
        prev = tilt;
        t = next && !isEnd(next) ? next : null;
    }

    for (const b of rig.bones) {
        const d = bakeFishRig(b, f, hooks);
        if (b.kind === 'body') {
            Object.assign(d, {
                amp: s.tailSweep * b.along * b.along, bendScale: 0, rollBend: s.pathBend * lerp(0.3, 1, b.along),
                pitchBias: (straightBias.get(b.node) || 0) * s.straighten,
                idleVariant: true, idleBias: 0, idleLag: d.lag, idlePitchBias: 0,
            });
            d.idleAmp = d.amp;
        } else if (b.kind === 'head') {
            Object.assign(d, { amp: -s.sealHeadSway, pitchBias: -rootTilt * s.straighten, rollBend: 0, idleVariant: true, idleBias: 0, idleLag: d.lag, idlePitchBias: 0 });
            d.idleAmp = d.amp;
        } else if (b.role === RigFin.Pectoral) {
            const r = b.chain === 0;
            Object.assign(d, {
                amp: s.flipperFlutter * (r ? 1 : 0.5), twistAmp: s.flipperTwist * (r ? 1 : 0.5), foldScale: 0, bias: r ? s.flipperTuck : 0,
                idleVariant: true, idleBias: 0, idleLag: d.lag,
            });
            d.idleAmp = d.amp;
        } else {
            Object.assign(d, { amp: 0, twistAmp: 0, bias: 0 });   // lông bụng / lưng / đỉnh đầu: đứng yên
        }
        a.register(b.node, d);
    }
    return a;
}
