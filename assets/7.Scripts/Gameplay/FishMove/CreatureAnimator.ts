import { Node, Quat, Vec3, clamp, clamp01, lerp } from 'cc';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const HIST = 128; // lịch sử tốc độ góc để lấy mẫu trễ theo vị trí trên thân

/**
 * Animator procedural cho sinh vật KHÔNG phải cá (bạch tuộc, cua), port từ bản Unity:
 *  - FishPoseJob (FishAnimationJobs.cs), nhánh FishBoneKind.Wave: engine tính pose dùng chung;
 *  - OctopusProceduralAnimator.cs / CrabProceduralAnimator.cs: tìm bone theo tên + cây, bake tham số mỗi bone;
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

/** Dữ liệu một bone đã bake (tương đương FishBoneData, chỉ phần Wave). */
interface WaveBone {
    node: Node;
    bindLocal: Quat;
    bindScale: Vec3;
    along: number;          // 0 đầu .. 1 đuôi: chỉ dùng cho độ trễ uốn theo đường bơi
    axis: number;           // 0 = up, 1 = dọc thân (+Z), 2 = finAxis
    finAxis: Vec3;          // root space, đơn vị
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
            swayFrequency: 1, swimSwayFrequency: 0, steadyRhythm: false, waveK: 0,
            idleSpeed: 0.6, swimSpeed: 1, blendSmoothing: 4,
            turnBend: 7, pitchBend: 5, bendDelay: 0.3, bendSmoothing: 10, maxBendPerBone: 14,
        }, p);
        this.p.swimSpeed = Math.max(this.p.swimSpeed, this.p.idleSpeed + 0.01);
    }

    /** Nhận diện rig bạch tuộc / cua dưới root (node gắn Fish); không phải thì null (Fish dùng sóng thân cá). */
    static tryCreate(root: Node): CreatureAnimator | null {
        const body = findShallowest(root, 'Spine');
        if (!body) return null;
        // cá (kể cả cua ẩn sĩ có chân / càng) có chuỗi thân Spine_2.. / Tail: để Fish.ts lo
        if (hasDescendant(body, n => /^(Spine|Tail)_?0*[2-9]/i.test(n.name) || /^Tail/i.test(n.name))) return null;
        const arms = children(body, 'Arm_');
        if (arms.some(a => child(a, 'Claw')) || children(body, 'Leg_').length > 0) return buildCrab(root, body);
        if (child(body, 'Head') && arms.length >= 3) return buildOctopus(root, body);
        return null;
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
            along: 0, axis: 0, finAxis: new Vec3(1, 0, 0),
            amp: 0, bias: 0, lag: 0, skew: 0, sharpen: 0, scaleAmp: new Vec3(),
            idleVariant: false, idleAmp: 0, idleBias: 0, idleLag: 0, idleSkew: 0, idleSharpen: 0, idleScaleAmp: new Vec3(),
            bendScale: 0, pitchBend: false, rollBend: 0, hasScale: false,
        };
        Object.assign(d, init);
        if (!d.idleVariant) {
            // không có bộ idle riêng: idle = bơi (Rebake của lớp cha)
            d.idleAmp = d.amp; d.idleBias = d.bias; d.idleLag = d.lag;
            d.idleSkew = d.skew; d.idleSharpen = d.sharpen; d.idleScaleAmp = d.scaleAmp.clone();
        }
        d.hasScale = !Vec3.equals(d.scaleAmp, Vec3.ZERO) || !Vec3.equals(d.idleScaleAmp, Vec3.ZERO);
        this.bones.push(d);
    }

    /** Sau khi đăng ký hết bone: cha trước con, đặt pha ban đầu theo timeOffset. */
    finish(timeOffset: number, speed: number): void {
        const depth = (n: Node) => { let k = 0; for (let t = n.parent; t; t = t.parent) k++; return k; };
        this.bones.sort((a, b) => depth(a.node) - depth(b.node));
        this.bodyPhase = timeOffset * this.p.swayFrequency * Math.PI * 2;
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
        this.bodyPhase += dt * lerp(p.swayFrequency * speed, swimSway, steady) * Math.PI * 2;
        this.applyPose(w, speed);
    }

    private applyPose(w: number, speed: number): void {
        const p = this.p;
        const rootRot = this.root.worldRotation;
        Vec3.transformQuat(_up, UP, rootRot);
        Vec3.transformQuat(_fwd, FWD, rootRot);
        Vec3.transformQuat(_lat, RIGHT, rootRot);
        const s = Math.max(speed, 0.05);
        const ampScale = lerp(Math.sqrt(s), 1, p.steadyRhythm ? w : 0); // nhịp ổn định: bơi biên độ = tham số

        for (const b of this.bones) {
            const parent = b.node.parent;
            if (!parent) continue;
            const wb = b.idleVariant ? w : 1;
            const amp = lerp(b.idleAmp, b.amp, wb);
            const lag = lerp(b.idleLag, b.lag, wb);
            const bias = lerp(b.idleBias, b.bias, wb);
            const skew = lerp(b.idleSkew, b.skew, wb);
            const sharpen = lerp(b.idleSharpen, b.sharpen, wb);

            const ph = this.bodyPhase - p.waveK * b.along - lag;
            let pulse = Math.sin(ph + skew * Math.sin(ph));
            if (sharpen > 0) { // ép về dạng vuông mượt: giữ ở hai đầu, chuyển nhanh
                const k = sharpen * 6;
                pulse = Math.tanh(k * pulse) / Math.tanh(k);
            }
            const a = bias + amp * ampScale * pulse;

            let by = 0, bp = 0, br = 0;
            if (b.bendScale > 0 || b.rollBend > 0) [by, bp, br] = this.getTurnBend(b.along, b.bendScale, b.rollBend);

            if (b.axis === 0) Vec3.copy(_axisW, _up);
            else if (b.axis === 1) Vec3.copy(_axisW, _fwd);
            else Vec3.transformQuat(_axisW, b.finAxis, rootRot);

            CreatureAnimator.rotateAbout(parent, _axisW, a + by, _qR);
            if (b.pitchBend) Quat.multiply(_qR, _qR, CreatureAnimator.rotateAbout(parent, _lat, bp, _qA));
            if (b.rollBend > 0) Quat.multiply(_qR, _qR, CreatureAnimator.rotateAbout(parent, _fwd, br, _qA));

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

function buildOctopus(root: Node, body: Node): CreatureAnimator {
    const o = OCTOPUS;
    const a = new CreatureAnimator('octopus', root, {
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

function buildCrab(root: Node, body: Node): CreatureAnimator {
    const c = CRAB;
    const a = new CreatureAnimator('crab', root, { swayFrequency: c.kickFrequency, waveK: 0 });

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
