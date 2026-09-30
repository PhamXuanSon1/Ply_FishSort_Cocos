import { _decorator, CircleCollider2D, Component, ERigidBody2DType, EventTouch, instantiate, Node, NodeSpace, ParticleSystem, RigidBody, RigidBody2D, tween, v2, v3, Vec3 } from 'cc';
import { Thing } from './Thing';
import { room } from './Room';
import { WaveSprite } from '../Misc/WaveSprite';
import { FishMove } from './FishMove/FishMove';
import { PoolMember, PoolType } from '../Pool/PoolMember';
import { pm } from '../Pool/PoolManager';
import { Fish } from './FishMove/Fish';
import Ulis, { cEasing } from '../Misc/Ulis';
import { truncate } from '../Manager/UI';
const { ccclass, property } = _decorator;

const HIT_COUNT = 8; // must match HIT_COUNT in WaveSprite.ts / builtin-sprite.effect

@ccclass('Bubble')
export class Bubble extends PoolMember {

    things: Thing[] = [];
    waveSprite: WaveSprite = null;

    // No more Physics2D - Room.update() checks every bubble pair's distance against (a.radius +
    // b.radius) each frame and calls onContact/onEndContact directly, so this is just a plain number.

    // Keyed directly by the other bubble's node (stable for as long as the collision lasts) - value
    // packs the last known world contact point (x, y) and the hit slot index it owns (z) into one
    // Vec3. onCollision itself is only ever called from update() below; onContact/onEndContact just
    // keep this map in sync.
    contactHits: Map<Node, Vec3> = new Map();
    nextHitIndex = 0;
    collider: CircleCollider2D = null;
    fishMove: FishMove = null;
    body: RigidBody2D = null;

    init(data: number[]) {
        let p = this.node.getChildByName("Fish");
        p.destroyAllChildren();
        p.removeAllChildren();
        this.things = [];

        let scale = Bubble.scaleFor(data.length);
        this.node.scale = v3(1, 1, 1).multiplyScalar(scale);
        
        this.fishMove = this.getComponent(FishMove);
        // const poseRadius = this.fishMove.radius;
        // const poseStartAngle = Math.random() * Math.PI * 2;
        // let poses = data.map((_, i) => {
        //     const a = poseStartAngle + (Math.PI * 2 / data.length) * i;
        //     return v3(Math.cos(a) * poseRadius, Math.sin(a) * poseRadius, 0);
        // });
        let length = data.length;
        let type = [1, 2, 6, 8, 10, 16, 17];
        data.forEach((d, i) => {

            // d = type[d];

            let thing = pm.spawnType<Thing>(PoolType.Thing);
            thing.node.parent = p;
            thing.node.position = v3();
            thing.node.eulerAngles = v3(0, 0, 0);
            thing.node.scale = v3(1, 1, 1).multiplyScalar(1/scale);
            thing.thingType = d;
            let fish = room.getSrc(d);
            let f = thing.getComponentInChildren(Fish);
            fish.parent = f.node;
            room.centerSrc(fish, d);
            fish.eulerAngles = v3(0, 0, 0);
            fish.scale = v3(1, 1, 1);
            fish.active = true;
            f.faceFront = room.frontTypes.includes(d);
            f.init();
            thing.init();
            thing.bubble = this;
            this.things.push(thing);
        })
        if(this.fishMove) {
            this.fishMove.init();
        }
        this.waveSprite = this.node.getComponentInChildren(WaveSprite);
        // Handle the whole gesture locally; UI nodes can swallow global input events.
        this.waveSprite.node.off(Node.EventType.TOUCH_START, this.onDragStart, this);
        this.waveSprite.node.off(Node.EventType.TOUCH_MOVE, this.onDragMove, this);
        this.waveSprite.node.off(Node.EventType.TOUCH_END, this.onDragEnd, this);
        this.waveSprite.node.off(Node.EventType.TOUCH_CANCEL, this.onDragEnd, this);
        this.waveSprite.node.on(Node.EventType.TOUCH_START, this.onDragStart, this);
        this.waveSprite.node.on(Node.EventType.TOUCH_MOVE, this.onDragMove, this);
        this.waveSprite.node.on(Node.EventType.TOUCH_END, this.onDragEnd, this);
        this.waveSprite.node.on(Node.EventType.TOUCH_CANCEL, this.onDragEnd, this);
        this.collider = this.getComponent(CircleCollider2D);
        this.fitFishes();
        this.body = this.getComponent(RigidBody2D);

        if(this.collider.sensor) {
            this.body.type = ERigidBody2DType.Dynamic;     
            this.collider.sensor = false;
            this.collider.apply();  
        }

        // this.body.linearVelocity = v2(0, length * 10);
    }

    onDragStart(event: EventTouch) {
        room.onTouchStart2(event);
    }

    onDragMove(event: EventTouch) {
        room.onTouchMove2(event);
    }

    onDragEnd(event: EventTouch) {
        room.onTouchEnd2(event);
    }

    // tỉ lệ bán kính bong bóng mà cá được phép chiếm (tính cả lúc bơi vòng / ngó nghiêng)
    @property
    fishFill: number = 0.95;

    /** Scale bong bóng theo số cá bên trong. */
    static scaleFor(n: number) {
        const minScale = 1, maxScale = 2.2, maxLen = 20;
        const t = Math.min((n - 1) / (maxLen - 1), 1);
        return (minScale + (maxScale - minScale) * cEasing('circOut')(t)) * 0.78;
    }

    // hệ số cỡ cá dùng chung cho mọi bong bóng (cache theo danh sách loại cá đang chơi)
    static fishK = { key: '', k: 1 };
    // bán kính mesh (local SK_FishN) quanh gốc - tâm xoay của cá, theo loại
    static fishReach: Map<number, number> = new Map();

    /**
     * Cỡ cá cố định còn bong bóng to/nhỏ theo số cá, nên bong bóng ít cá dễ bị cá lòi ra ngoài. Tính 1 hệ số
     * chung cho mọi bong bóng (1..room.maxFishPerBubble cá, mọi loại đang chơi) theo trường hợp chật nhất: vị trí trên vòng bơi +
     * drift ngó nghiêng/nhấp nhô + bán kính mesh quanh tâm xoay (không phụ thuộc hướng xoay) <= fishFill bán kính
     * bong bóng. Mọi bong bóng dùng cùng hệ số nên cá trong bong bóng đơn cũng cùng cỡ với bong bóng nhiều cá.
     */
    fitFishes() {
        let t0 = this.things[0];
        let src = t0?.getComponentInChildren(Fish)?.node.children[0];
        if(!src) return;
        this.things.forEach(t => t.node.scale = v3(1, 1, 1).multiplyScalar(1 / this.node.scale.x));

        let types = room.fishTypes.filter(t => room.getFishPoints(t));
        let key = types.join(',') + '|' + room.maxFishPerBubble;
        if(Bubble.fishK.key != key) {
            let ws = t0.node.worldScale.x;
            let srcWS = src.worldScale.x;
            let parentWS = this.node.parent.worldScale.x;
            let fm = this.fishMove;
            let drift = fm ? Math.SQRT2 * fm.idleAmplitude + fm.bobAmplitude : 0;
            let k = 1;
            for(let n = 1; n <= Math.max(1, room.maxFishPerBubble); n++) {
                let R = this.collider.radius * parentWS * Bubble.scaleFor(n) * this.fishFill;
                let orbit = fm && n > 1 ? fm.radius : 0;
                types.forEach(type => {
                    let need = (orbit + drift) * ws + Bubble.reachOf(type) * srcWS;
                    if(need > 0) k = Math.min(k, R / need);
                });
            }
            Bubble.fishK = { key, k };
        }
        let k = Bubble.fishK.k;
        if(k < 1) this.things.forEach(t => t.node.scale = t.node.scale.clone().multiplyScalar(k));
    }

    static reachOf(type: number) {
        if(Bubble.fishReach.has(type)) return Bubble.fishReach.get(type);
        let pts = room.getFishPoints(type);
        let c = room.getFishCenter(type);
        let r = 0;
        for(let i = 0; pts && i < pts.length; i += 3) r = Math.max(r, Math.hypot(pts[i] - c.x, pts[i + 1] - c.y, pts[i + 2] - c.z));
        Bubble.fishReach.set(type, r);
        return r;
    }

    /** Đảo ngược init(): trả về đúng 1 phần tử của Room.BubbleData ([x, y, types]) theo vị trí + loại cá hiện tại. */
    toData(): [number, number, number[]] {
        let things = this.getComponentsInChildren(Thing);
        return [truncate(this.node.position.x, 3), truncate(this.node.position.y, 3), things.map(t => t.thingType)];
    }

    // Called by Room.update() while `other` is within collision range.
    onContact(other: Bubble, wpos: Vec3) {
        const otherNode = other.node;

        const existing = this.contactHits.get(otherNode);
        const index = existing ? existing.z : this.nextHitIndex;
        if(!existing) {
            this.nextHitIndex = (this.nextHitIndex + 1) % HIT_COUNT;
        }
        this.contactHits.set(otherNode, v3(wpos.x, wpos.y, index));
    }

    // Called by Room.update() once `other` moves back out of collision range.
    onEndContact(other: Bubble) {
        const otherNode = other.node;
        const entry = this.contactHits.get(otherNode);
        if(entry) {
            this.waveSprite.clearHit(entry.z);
            this.contactHits.delete(otherNode);
        }
    }

    onThingOut(thing: Thing) {
        room.things = room.things.filter(t => t != thing);
        this.things = this.things.filter(t => t != thing);
        thing.bubble = null;
        this.fishMove.removeFish(thing.fish);
        this.touch();
        // console.log(this.things.length);
        
        if(this.things.length == 0) {
            room.onEmptyBubble(this);



            setTimeout(() => {
                // this.node.active = false; 
                
                // this.node.position = v3(0, 100000, -100000); 

                this.things = [];
                this.contactHits = new Map();
                this.nextHitIndex = 0;

                this.body.type = ERigidBody2DType.Static;     
                this.collider.sensor = true;
                this.collider.apply();    

                let s = this.node.getScale().multiplyScalar(1.2);
                tween(this.node)
                .to(0.1, {scale: s})
                .call(() => {
                    let pop = pm.spawn(PoolType.Pop);
                    pop.node.setParent(room.vfxNode);
                    pop.node.worldPosition = this.node.getWorldPosition();
                    pop.node.worldScale = this.node.getWorldScale();
                    let vfx = pop.getComponentInChildren(ParticleSystem)
                    vfx.clear();
                    vfx.play();
                    setTimeout(() => {
                        vfx.clear();
                        setTimeout(() => {
                            pm.despawn(pop);                          
                        }, 100);              
                    }, 1000); 
                    pm.despawn(this);                    
                })
                .start();



                // this.node.destroy(); 
            }, 100);

        }
    }

    touch() {
        let size = this.waveSprite.uit.contentSize;
        let aRadius = this.collider.radius * this.node.getWorldScale().x;
        let wpos = this.waveSprite.node.getWorldPosition().add(v3(0, aRadius, 0));
        this.waveSprite.onTouch(wpos, NodeSpace.WORLD);
    }

    update(deltaTime: number) {
        // The only place onCollision is called: pushes each still-active hit's last known contact
        // point (kept fresh by onContact, called every frame from Room.checkBubbleCollisions()) to
        // the shader.
        this.contactHits.forEach((entry) => {
            this.waveSprite.onCollision(v3(entry.x, entry.y, 0), NodeSpace.WORLD, entry.z);
        });
    }
}


