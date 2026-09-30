import { _decorator, Animation, CCObjectFlags, Component, EventKeyboard, EventTouch, gfx, Input, input, instantiate, JsonAsset, KeyCode, Mat4, Mesh, MeshRenderer, misc, Node, PhysicsSystem, PhysicsSystem2D, Scene, SkinnedMeshRenderer, Sprite, Tween, tween, UITransform, v2, v3, Vec2, Vec3 } from 'cc';
import { Thing } from './Thing';
import { Slot } from './Slot';
import { ipm } from '../Manager/InputManager';
import { ui } from '../Manager/UI';
import Ulis, { cEasing } from '../Misc/Ulis';
import { sm, SoundType } from '../Manager/SoundManager';
import { EDITOR, EDITOR_NOT_IN_PREVIEW } from 'cc/env';
import { Bubble } from './Bubble';
import { Fish } from './FishMove/Fish';
import { pm } from '../Pool/PoolManager';
import { PoolType } from '../Pool/PoolMember';
import { WaveSprite } from '../Misc/WaveSprite';
import { Mats } from '../Misc/Mats';
import { AppLovinAnalytics } from '../Tool/AppLovinAnalytics';
import { Clock } from '../Manager/Clock';
import { splitSum } from '../MatchAsset/Ulis';
const { ccclass, property, executeInEditMode } = _decorator;


export var room: Room = null;


/**
 * Dữ liệu bong bóng: mỗi phần tử [x, y, types] - x/y là vị trí đặt bong bóng, types là mảng chỉ số loại cá bên
 * trong (chỉ số ứng với room.fish.children[index], xem Bubble.init()). Thay cho FishData cũ (chỉ có danh sách
 * loại cá dùng xáo trộn rồi chia đều cho các bong bóng đã đặt sẵn trong scene) - giờ vị trí cũng nằm trong data,
 * bong bóng được spawn từ PoolType.Bubble tại đúng vị trí đó (cần cấu hình sẵn 1 mục Bubble trong
 * PoolControl.poolAmounts) thay vì tìm bong bóng có sẵn trong thingNode.
 */
export const BubbleData: 
[number, number, number[]][] = 
[[132.428,1268.46,[26,26]],[-621.029,874.37,[32,29,33]],[620.997,1242.781,[29,27,37]],[-331.329,1268.474,[23,23]],[311.746,840.762,[26,23]],[710.886,827.523,[27]],[710.774,492.52,[23]],[-147.621,672.359,[32,29,27]],[245.951,381.656,[27,26]],[-226.381,189.451,[23,26]],[620.976,67.396,[37,23,32]],[-646.47,385.848,[30,37]],[125.572,0.849,[30]],[-646.417,-77.964,[37,29]],[-181.644,-297.852,[26,26,23]],[-620.956,-566.574,[29,33,27]],[342.884,-253.975,[23]],[101.306,-697.127,[23,37]],[-602.293,-1099.642,[33,32,33,30]],[-56.128,-1180.229,[26,33,32,30]],[602.341,-613.586,[30,27,26,37]],[495.364,-1155.148,[32,30,29,33]]]

/**
 * Thứ tự hộp ra slot, tính từ BubbleData (không hard code): mỗi loại cá n con -> n/3 nhóm [t, t, t].
 * Chia theo vòng, mỗi vòng mỗi loại 1 nhóm (4 slot đầu không trùng loại). Trong vòng k, loại nào có con cao
 * thứ 3(k+1) nằm cao hơn (gom đủ 3 con sớm hơn) thì lên slot trước.
 */
export function buildItems(data: [number, number, number[]][]): number[][] {
    let ys = new Map<number, number[]>();
    data.forEach(([, y, types]) => types.forEach(t => {
        if(!ys.has(t)) ys.set(t, []);
        ys.get(t).push(y);
    }));
    ys.forEach(list => list.sort((a, b) => b - a));

    let items: number[][] = [];
    for(let k = 0; ; k++) {
        let round = [...ys.keys()].filter(t => ys.get(t).length >= 3 * (k + 1));
        if(round.length == 0) break;
        round.sort((a, b) => ys.get(b)[3 * k + 2] - ys.get(a)[3 * k + 2]);
        round.forEach(t => items.push([t, t, t]));
    }
    return items;
}






@ccclass('Room')
@executeInEditMode(true)
export class Room extends Component {

    onLoad() {
        room = this;
    }

    start() {
        this.init();
    }


    @property(Node)
    slotNode: Node = null
    @property(Node)
    thingNode: Node = null
    @property(Node)
    boxNode: Node = null
    @property(Node)
    vfxNode: Node = null
    @property(Node)
    thingAbove: Node = null
    @property(Node)
    hideNode: Node = null
    @property(Node)
    clockNode: Node = null
    clock: Clock = null
    slotAmount: number = 4
    boxAmount: number = 5
    slotDis: number = 262
    boxDis: number = 200

    @property(Sprite)
    progressBar: Sprite = null
    progress: number = 0
    totalBox: number = 0

    // @property([Thing])
    things: Thing[] = []
    slots: Slot[] = []
    boxes: Slot[] = []
    zoomed: boolean = false

    map: Map<number, number> = new Map()
    @property([Node])
    taps: Node[] = []

    startPos: Vec3 = null
    s1: Vec2 = null!;
    s2: Vec2 = null!;
    location: Vec2 = null!;
    maxScale: number = 0.8;
    maxMoveX: number = 400;
    maxMoveY: number = 200;
    hintTween: Tween<any> = null;
    firstHandHintTween: Tween<any> = null;
    firstHandHintScheduled: boolean = false;
    firstHandHintShown: boolean = false;
    private dragTouchId: number = null;

    @property({ type: Number, tooltip: 'Số giây chờ trước khi hiện hand hint.' })
    handHintDelay: number = 5;

    // khai báo firstTapCount để xác định số lần chạm đầu tiên mà người chơi cần thực hiện trước khi trò chơi bắt đầu.
    @property({ type: Number })
    fisrtTapCount: number = 3;

    items: number[][] = [];

    tappable: boolean = false

    lose: boolean = false

    @property
    maxPick: number = 15;
    @property
    maxBox: number = 99;
    fish: Node = null
    total: number = 0

    srcPool: Node[][] = []
    @property
    gravityY: number = 10;
    @property
    gravityY2: number = 100;
    
    mat: Mats = null
    initMats() {
        this.fish = this.node.getChildByName("Fish");
        this.mat = this.node.getChildByName("Material").getComponentInChildren(Mats);
        this.mat.init();
    }

    initClock() {
        this.clock = this.clockNode?.getComponent(Clock);
        this.clock?.init();
        if(this.clock) this.clock.onTimeUp = this.onLose.bind(this);
    }

    onChangeMats() {
        this.things.forEach(t => {
            t.setMeshMat();
        })
    }

    init() {

        input.on(Input.EventType.KEY_DOWN, (e: EventKeyboard) => {
            let k = e.keyCode;
            if(k == KeyCode.SPACE) {
                this.printBubble = !this.printBubble;
            }
        });

        this.initClock();
        this.initMats();
        this.items = buildItems(BubbleData);
        this.totalBox = this.items.length;
        console.log("Total box", this.items.length);
        this.fish = this.node.getChildByName("Fish");

        // this.fish.children.forEach((c, i) => {
        //     c.name = "SK_Fish" + i;
        // })

        this.initBoxes();
        this.initSlots();
        this.initBubbles();
        this.initThings();
        this.zoom();
        // this.onFirst();
        this.schedule(this.onSchedule.bind(this), 0.5);

        // PhysicsSystem2D.instance.gravity = new Vec2(0, this.gravityY);
        

        // this.thingNode.getChildByName("Button")?.on(Node.EventType.TOUCH_START, this.onButton, this);
    }

    spawnUnlimited() {

        // return;
        if(this.things.length < 18 * 3) {
            let dt = [
                [4, 0],
                [3, 1],
                [2, 2],
                [1, 2],
            ]

            // chỉ loại có model trong Room > Fish, loại thiếu model sẽ thành cá vô hình (bong bóng trống)
            let available = this.fishTypes.filter(t => this.fish.children[t]?.children.length > 0);
            if(available.length == 0) return;
            let maxType = available.length < 4 ? available.length : 4;

            let types = Ulis.shuffleArray(available).slice(0, maxType);

            // dt: [số cá trong 1 bong bóng, số bong bóng]
            let typeAmount = [];
            dt.forEach(([size, amount]) => {
                typeAmount.push(...Array(amount).fill(size));
            })
            typeAmount = Ulis.shuffleArray(typeAmount);

            // số nhóm theo đúng số chỗ trong bong bóng - mọi nhóm đẩy vào items đều có đủ 3 con được spawn
            let totalFish = typeAmount.reduce((a, b) => a + b, 0);
            let totalBox = Math.floor(totalFish / 3);
            let fishes = [];
            for (let i = 0; i < totalBox; i++) {
                let type = types[i % types.length];
                let f = Array(3).fill(type);
                this.items.push(f);
                fishes.push(...f);
            }
            fishes = Ulis.shuffleArray(fishes);

            let cursor = 0;
            let groups: number[][] = typeAmount.map(size => {
                let g = fishes.slice(cursor, cursor + size);
                cursor += size;
                return g;
            }).filter(g => g.length > 0);
            Room.breakTriples(groups);

            const data: any[] = groups.map((types, i) => [0, -5000 - i * 500, types]);

            // console.log(typeAmount, fishes, data);
            

            data.forEach(([x, y, types]) => {
                let bubble = pm.spawnType<Bubble>(PoolType.Bubble);
                bubble.node.parent = this.thingNode;
                bubble.node.position = v3(x, y, 0);
                bubble.node._objFlags = CCObjectFlags.DontSave;
                bubble.init(types);
                this.bubbles.push(bubble);

                this.things.push(...bubble.things);
            })
        }
    }

    /** Đổi chỗ cá giữa các bong bóng để không bong bóng nào có từ 3 con cùng loại (3 con 1 chỗ = gom quá dễ). */
    static breakTriples(groups: number[][]) {
        let count = (g: number[], t: number) => g.filter(x => x == t).length;
        for(let gi = 0; gi < groups.length; gi++) {
            let g = groups[gi];
            for(let i = 0; i < g.length; i++) {
                let t = g[i];
                if(count(g, t) < 3) continue;
                // tìm con khác loại ở bong bóng khác mà đổi xong cả 2 bên đều < 3 con cùng loại
                let done = false;
                for(let oi = 0; oi < groups.length && !done; oi++) {
                    let o = groups[oi];
                    if(o == g) continue;
                    for(let j = 0; j < o.length && !done; j++) {
                        let u = o[j];
                        if(u == t || count(o, t) >= 2 || count(g, u) >= 2) continue;
                        g[i] = u;
                        o[j] = t;
                        done = true;
                    }
                }
            }
        }
    }

    bubbles: Bubble[] = [];
    initBubbles() {
        this.thingNode.destroyAllChildren();
        this.thingNode.removeAllChildren();
        this.bubbles = Room.limitBubbleSize(BubbleData, this.maxFishPerBubble).map(([x, y, types]) => {
            let bubble = pm.spawnType<Bubble>(PoolType.Bubble);
            bubble.node.parent = this.thingNode;
            bubble.node.position = v3(x, y, 0);
            bubble.node._objFlags = CCObjectFlags.DontSave;
            bubble.init(types);
            return bubble;
        });
    }

    // số cá tối đa trong 1 bong bóng - bong bóng nhiều hơn trong BubbleData được chia bớt lúc spawn
    @property
    maxFishPerBubble: number = 3;

    /**
     * Giới hạn mỗi bong bóng tối đa `max` con: cá dư chuyển sang bong bóng gần nhất còn chỗ (không có thì tạo
     * bong bóng mới ngay dưới), rồi đổi chỗ để không bong bóng nào có 3 con cùng loại. Tổng cá mỗi loại giữ nguyên.
     */
    static limitBubbleSize(data: [number, number, number[]][], max: number): [number, number, number[]][] {
        let out: [number, number, number[]][] = data.map(([x, y, types]) => [x, y, [...types]]);
        if(!(max > 0)) return out;
        let extra: [number, number, number][] = [];
        out.forEach(([x, y, types]) => {
            while(types.length > max) extra.push([x, y, types.pop()]);
        });
        extra.forEach(([x, y, type]) => {
            let target = out.filter(d => d[2].length < max)
                .sort((a, b) => Math.hypot(a[0] - x, a[1] - y) - Math.hypot(b[0] - x, b[1] - y))[0];
            if(target) target[2].push(type);
            else out.push([x, y - 300, [type]]);
        });
        Room.breakTriples(out.map(d => d[2]));
        return out;
    }

    /** Sinh ngẫu nhiên 1 mảng đúng định dạng BubbleData ([x, y, types] mỗi phần tử) theo params: box là vùng
     * [minX, maxX, minY, maxY] để random vị trí, bubleAmount là số lượng bubble cần tạo cho mỗi cỡ (cỡ = số cá
     * bên trong), typeAmount là danh sách loại cá được phép chọn. */
    randomBubles(params: { box: [number, number, number, number]; bubleAmount: Record<number, number>; fishTypes: number[] } = {
        box: [-500, 500, -1000, 1000],
        // Số lượng mỗi loại bubble chứa đc 1, 2, 3 và 4 cá.
        // Các loại cá hiện tại là 0, 1, 2
        bubleAmount: {
            1: 2,
            2: 3,
            3: 3,
            4: 2,
        },
        fishTypes: [0, 1, 2]
    }): [number, number, number[]][] {
        // Danh sách cỡ bubble cần tạo, ví dụ bubleAmount={1:2,2:3} -> [1,1,2,2,2].
        let sizes: number[] = [];
        for (const size in params.bubleAmount) {
            for (let i = 0; i < params.bubleAmount[size]; i++) sizes.push(Number(size));
        }

        const [minX, maxX, minY, maxY] = params.box;
        const data = sizes.map((size): [number, number, number[]] => {
            const types = Array.from({ length: size }, () => params.fishTypes[Ulis.iRand(0, params.fishTypes.length - 1)]);
            return [Ulis.iRand(minX, maxX), Ulis.iRand(minY, maxY), types];
        });
        console.log(JSON.stringify(data));
        return data;
    }

    /** Tương tự randomBubles() nhưng lấy vị trí + số cá (size) từ các bubble ĐANG CÓ SẴN trong scene (giữ nguyên,
     * không random), chỉ tính lại types theo fishTypes. Tổng số cá cần gán chia thành từng nhóm 3 con (khớp sức
     * chứa tối đa 1 slot) - mỗi nhóm 3 con liên tiếp nhận 1 loại, xoay vòng theo fishTypes; phần dư không đủ 1
     * nhóm 3 thì bỏ (ví dụ totalFish=20, fishTypes=[0,1,2,3] -> 20 = 3*6 + 2: 6 nhóm liên tục nhận loại
     * 0,1,2,3,0,1, 2 con dư cuối không được gán loại). */
    randomFromAvailableBubbles(fishTypes: number[] = [0, 1, 2]): [number, number, number[]][] {
        const bubbles = this.thingNode.getComponentsInChildren(Bubble);
        const sizes = bubbles.map(b => b.getComponentsInChildren(Thing).length);
        const totalFish = sizes.reduce((sum, n) => sum + n, 0);

        const GROUP_SIZE = 3;
        const groupCount = Math.floor(totalFish / GROUP_SIZE);
        var typeStream: number[] = [];
        for (let g = 0; g < groupCount; g++) {
            const type = fishTypes[g % fishTypes.length];
            for (let i = 0; i < GROUP_SIZE; i++) typeStream.push(type);
        }

        typeStream = Ulis.shuffleArray(typeStream);

        // Đổ typeStream tuần tự vào từng bubble theo đúng size hiện tại - bubble nào rơi đúng lúc typeStream cạn
        // (do phần dư bị bỏ) sẽ nhận ít type hơn size gốc.
        let cursor = 0;
        const data = bubbles.map((b, i): [number, number, number[]] => {
            const size = sizes[i];
            const types = typeStream.slice(cursor, cursor + size);
            cursor += size;
            return [b.node.position.x, b.node.position.y, types];
        });
        console.log(JSON.stringify(data));
        return data;
    }


    @property
    set printBubble(v: boolean) { this.printBubbleData(); }
    get printBubble() { return false; }

    @property
    set genBuble(v: boolean) { this.randomBubles(); }
    get genBuble() { return false; }

    @property([Number])
    fishTypes: number[] = [0, 1, 2];
    @property
    set genBubleFromAvai(v: boolean) { this.randomFromAvailableBubbles(this.fishTypes); }
    get genBubleFromAvai() { return false; }

    /**
     * Đảo ngược initBubbles(): in ra console đúng định dạng BubbleData ([x, y, types] cho từng bubble) theo vị
     * trí + loại cá hiện tại của this.bubbles - dùng sau khi tự kéo thả/chỉnh vị trí bubble trong Editor, copy kết
     * quả dán ngược vào BubbleData.
     */
    printBubbleData(): void {
        let bubbles  = this.thingNode.getComponentsInChildren(Bubble);
        console.log(JSON.stringify(bubbles.map(b => b.toData())));
    }

    onEmptyBubble(bubble: Bubble) {
        // Bubble sắp rời khỏi this.bubbles nên checkBubbleCollisions() sẽ không còn xét cặp nào có nó nữa -
        // tự kết thúc mọi contact nó đang giữ (đối xứng, giống checkBubbleCollisions) để bên kia dọn contactHits/wave đúng cách.
        for (const [node] of bubble.contactHits) {
            const other = this.bubbles.find(b => b.node === node);
            if (other) {
                bubble.onEndContact(other);
                other.onEndContact(bubble);
            }
        }
        this.bubbles = this.bubbles.filter(b => b != bubble);
    }

    // Manual replacement for Physics2D contact events: every frame, check each pair of bubbles' world
    // distance against the sum of their radii, and call onContact/onEndContact directly instead of
    // waiting on Box2D. Only bubble-vs-bubble is checked here - other objects (Things, walls) don't
    // take part in this at all.
    checkBubbleCollisions() {
        for (let i = 0; i < this.bubbles.length; i++) {
            for (let j = i + 1; j < this.bubbles.length; j++) {
                const a = this.bubbles[i];
                const b = this.bubbles[j];
                const posA = a.node.getWorldPosition();
                const posB = b.node.getWorldPosition();
                const dist = Vec3.distance(posA, posB);
                let aRadius = a.collider.radius * a.node.getWorldScale().x;
                let bRadius = b.collider.radius * b.node.getWorldScale().x;
                const minDist = aRadius + bRadius;
                const wasColliding = a.contactHits.has(b.node);

                if (dist < minDist) {
                    const dir = dist > 0.0001 ? posB.clone().subtract(posA).normalize() : v3(1, 0, 0);
                    const wposOnA = posA.clone().add(dir.clone().multiplyScalar(aRadius));
                    const wposOnB = posB.clone().add(dir.clone().multiplyScalar(-bRadius));
                    a.onContact(b, wposOnA);
                    b.onContact(a, wposOnB);
                } else if (wasColliding) {                  
                    if(dist > minDist + 2) 
                    {
                        a.onEndContact(b);
                        b.onEndContact(a);
                    }
                }
            }
        }
    }

    first: boolean = true;
    onFirst() {
        if(!this.first) return;
        this.first = false;
        AppLovinAnalytics.challengeStarted();
        this.clock?.count();
    }

    onButton(event: EventTouch, ...arg) {
        let node = event.target as Node;
        let sp = node.getComponent(Sprite);
        let c = sp.color.clone();
        let a = c.a + 0.0;
        tween(sp)
        .to(0.1, {}, {easing: 'smooth', 
            onUpdate(target, ratio) {
                c.a = a * (1 - ratio);
                sp.color = c;
            },
        })
        .start();
        
        this.thingNode.getChildByName("Button").off(Node.EventType.TOUCH_START, this.onButton, this);

        this.onTouchStart(event);
        
    }

    onSchedule() {
        // if(this.checkLose()) return;

        let boxes = this.boxes.filter(b => b.thing && !b.moving && !b.thing.waiting);
        let things = boxes.map(b => b.thing);
        things.forEach(t => {
            let thingyType = t.thingType;
            let slot = this.slots.find(s => s.thingType == thingyType);
            if(slot && slot.added + slot.queue.length < slot.amount) {
                this.queueSlot(t);
            }
        });
        room.checkLose();
        
        if(this.tappable) {
            let emptyBox = this.boxes.filter(b => b.thingType == -1);
            if(emptyBox.length > 1) {
                this.warning.active = false;            
            }
        }

        this.spawnUnlimited();
    }

    @property(Node)
    warning: Node = null
    moved() {

        let moving = this.boxes.find(b => b.moving);
        let movingSlot = this.slots.find(s => s.moving);
        if(moving || movingSlot) return;

        let emptyBox = this.boxes.filter(b => b.thingType == -1);
        if(this.tappable) {
            // console.log(emptyBox.length);
            
            if(emptyBox.length == 1) {
                let anim = emptyBox[0]?.getComponent(Animation);
                if(anim && !anim.getState("Box").isPlaying) {
                    anim.play();
                    sm.playSound(SoundType.Alert);
                } 
            } else if(emptyBox.length > 1) {
                this.warning.active = false;            
            }

            if(this.faked) {
                if(emptyBox.length > 0) {
                    this.reseted = true;
                }
            }
        }
        
    }

    @property(Node)
    loseFake: Node = null
    faked: boolean = false
    reseted: boolean = false
    checkLose() {

        let moving = this.boxes.find(b => b.moving);
        let movingSlot = this.slots.find(s => s.moving);
        let mivingThing = this.things.find(t => t.moving);
        if(moving || movingSlot || mivingThing) return;

        let emptyBox = this.boxes.find(b => b.thingType == -1);
        if(!emptyBox && !this.lose) {                
            this.hintTween?.stop();
            ui.offHand();
            this.unschedule(this.onSchedule.bind(this));
            this.onLose();
        }

        return !emptyBox;
    }

    onLose() {
        this.things.forEach((t) => {
            t.offTouch()
        });
        ui.onLose();
        this.lose = true;
        console.log("lose");
    }

    @property(Node)
    next: Node = null
    onRevive() {
        room.node.active = false;
        this.loseFake.active = false;
        if(this.next) {
            this.next.active = true;
        }
    }

    tap(thing: Node) {
        if(!this.tappable) return;
        if(thing) {
            let tt = thing.getComponent(Thing)
            let s = this.slots.find(s => s.thingType == tt.thingType);
        }
        this.taps = this.taps.filter(t => {
            return t != thing && (!thing || t != thing.getComponent(Thing).touch);
        });
        let t = this.taps.shift();
        // console.log(t);
        
        if(t) {
            let th = t.getComponent(Thing);
            if(!this.firstHandHintShown && !this.firstHandHintScheduled && this.fisrtTapCount > 0) {
                this.firstHandHintScheduled = true;
                this.firstHandHintTween = tween({})
                .delay(Math.max(0, this.handHintDelay))
                .call(() => {
                    this.firstHandHintScheduled = false;
                    const nextHint = this.taps[0]?.getComponent(Thing);
                    if(!this.lose && this.tappable && nextHint?.touch?.isValid) {
                        this.firstHandHintShown = true;
                        ui?.handTap(nextHint.touch);
                    }
                })
                .start();
            } else if(this.firstHandHintShown || this.fisrtTapCount <= 0) {
                ui?.handTap(th.touch);
            }
        } else {
            ui?.offHand();
            this.hint();
        }
    }


    hint() {
        this.hintTween?.stop();
        if(this.lose || this.bound) return;
        this.hintTween = tween({})
        .delay(this.firstHandHintShown ? 5 : Math.max(0, this.handHintDelay))
        .call(() => {
            if(!ui.hand.active) {
                if(this.taps.length == 0 && this.things.length > 0) {
                    let thingFindout: Thing = null;
                    let sl = [...this.slots];
                    sl.sort((a, b) => a.amount - a.added - b.amount + b.added);
                    if(sl.length == 0) return;
                    let type = sl[0].thingType;
                    let t = this.things.filter(t => t.thingType == type)
                    t.sort((a, b) => - a.node.worldPosition.y + b.node.worldPosition.y);
                    // .reverse();
                    thingFindout = t[0];
                    if(thingFindout) {
                        console.log(thingFindout.node.worldPosition, ui.width, ui.height);
                        
                        this.taps = [thingFindout.node];
                        this.firstHandHintShown = true;
                        this.tap(null);
                    } else {
                        this.hint();
                    }
                } else {
                    this.hint();
                }
            }
        })
        .start();
    }

    zoom() {

        this.hideNode.active = false;
        this.node.scale = v3(1, 1, 1)
        .multiplyScalar(0.8);
        ui?.offHand();
        let pos = this.thingNode.getPosition();
        const t = this;
        tween(this.node)
        .delay(0.25)
        .to(0.5, {scale: v3(1, 1, 1)}, {
            onUpdate(target, ratio) {
                // t.thingNode.position = Vec3.lerp(v3(), pos, pos.clone().add(v3(-80)), ratio);
            },
        })
        .call(() => {
            ui.resize();
            this.tappable = true;
            this.binding();
            this.zoomed = true;
            this.hideNode.active = true;
            console.log("Done");
            
            this.tap(null);
        })
        // .start();
        
        this.node.scale = v3(1, 1, 1)
        this.binding();
        this.hideNode.active = true;
        // setTimeout(() => {     
            this.tappable = true;
            this.zoomed = true;       
            this.tap(null);
            // PhysicsSystem2D.instance.gravity = new Vec2(0, this.gravityY2);
        // }, 3000);
    }

    setSlotThing(slot: Slot, shuffle: boolean = false): boolean {
        let keys = [];
        
        let keyMap: number[][] = [];
        for( let [key, value] of this.map) {
            keyMap.push([key, value]);
        }

        if(shuffle) {
            // keyMap = Ulis.shuffleArray(keyMap);
            // console.log(keyMap);
            
            keyMap.sort((a, b) => b[1] - a[1]);
            
        }
            

        // for( let [key, value] of this.map) {
        for( let i = 0; i < keyMap.length; i++) {
            let key = keyMap[i][0];
            let value = keyMap[i][1];
            console.log(key, value);
            
            if(value > 0) {    
                let thing = this.things.find(t => t.thingType == key);
                if(!thing) {
                    thing = this.boxes.map(b => b.thing).find(t => t && t.thingType == key);
                }
                if(!thing) return false;
                slot.thingType = key;
                slot.setThingFrame(thing);    
                slot.added = 0;
                slot.setLabel(value);
                keys.push(key);
                break;
            }
        }
        keys.forEach(k => {
            this.map.set(k, this.map.get(k) - 3);
        })
        return keys.length > 0;
    }

    onTouch(event: EventTouch) {
        let pos = event.getUILocation();
        let pos3 = v3(pos.x, pos.y, 0);
        for(let i = 0; i < this.bubbles.length; i++) {
            let b = this.bubbles[i];
            let wpos = b.node.getWorldPosition();
            wpos.z = 0;
            let scale = b.node.worldScale.x;
            let radius = b.collider.radius * scale;
            if(Vec3.distance(pos3, wpos) < radius) {
                b.getComponentInChildren(WaveSprite).onTouchStart(event);
                break;
            }
        }
    }


    // Kéo để highlight, thả tay để chọn cá.
    @property
    dragCollect: boolean = true;
    // hệ số vùng bắt khi kéo, nhân với nửa cạnh node Touch của cá
    @property
    dragHitScale: number = 1;

    /** Khi đang kéo, chỉ highlight cá dưới ngón tay; thao tác chọn cá được xử lý khi thả. */
    collectAt(pos: Vec2) {
        if(this.dragTouchId === null || !this.dragCollect || !this.zoomed || this.lose || this.bound) return;
        this.updateDragHighlight(pos);
    }

    getNearestThing(pos: Vec2, multiplier: number = 1) {
        let pos3 = v3(pos.x, pos.y, 0);
        let dis = null;
        let neareast: Thing = null;
        for(let i = 0; i < this.things.length; i++) {
            let thing = this.things[i];
            if(!thing.node?.isValid || !thing.touch?.isValid || thing.moving || thing.waiting) continue;
            let wpos = thing.touch.getWorldPosition();
            wpos.z = 0;
            let d = Vec3.distance(pos3, wpos);
            if(dis === null) {
                dis = d;
                neareast = thing;
            } else {
                if(d < dis) {
                    dis = d;
                    neareast = thing;
                }
            }
        }

        if(!neareast?.touch) return null;

        let width = neareast.touch.getWorldScale().x * 
        neareast.touch.getComponent(UITransform).width;

        if(dis < width / 2 * multiplier) {
            return neareast;
        } 

        return null;       
    }

    onTouchStart2(event: EventTouch) {
        if(!event || this.dragTouchId !== null) return;
        this.clearDragHighlight();
        this.dragTouchId = event.getID();
    }

    hThing: Thing = null;
    onTouchMove2(event: EventTouch) {
        if(!event || this.dragTouchId === null || event.getID() !== this.dragTouchId) return;
        this.collectAt(event.getUILocation());
    }

    updateDragHighlight(pos: Vec2) {
        const neareast = this.getNearestThing(pos, 1.5);
        if(neareast === this.hThing) return;
        this.clearDragHighlight();
        if(neareast) {
            this.hThing = neareast;
            neareast.onHightlight();
        }
    }

    clearDragHighlight() {
        if(this.hThing?.node?.isValid) this.hThing.offHightlight();
        this.hThing = null;
    }

    onTouchEnd2(event: EventTouch) {
        this.finishDragHighlight(event);
    }

    finishDragHighlight(event: EventTouch) {
        if(!event || this.dragTouchId === null || event.getID() !== this.dragTouchId) return;
        // Consume this gesture before picking: node and global handlers may both receive the release.
        this.dragTouchId = null;
        const selectedThing = this.hThing;
        this.clearDragHighlight();
        if(!this.dragCollect || !this.zoomed || this.lose || this.bound) return;
        if(selectedThing?.node?.isValid && this.things.includes(selectedThing)
            && !selectedThing.moving && !selectedThing.waiting) {
            selectedThing.onTouchStart(event);
        }
    }

    getSrc(index: number) {
        if(!this.srcPool[index]) this.srcPool[index] = [];
        let src  = this.srcPool[index].pop();
        if(!src) {
            let fish = room.fish.children[index];
            src = instantiate(fish);            
        }
        src["index"] = index;
        return src;
    }
    
    despawnSrc(src: Node) {
        // let index = src["index"];
        // src.setParent(this.fish);
        // this.srcPool[index].push(src);
        src.destroy();
    }

    /**
     * Chọn nhóm trong items cho slot theo vị trí cá lúc này (không theo thứ tự cố định): loại chưa có ở slot khác,
     * đủ cá để gom 3 con và gom đủ sớm nhất - cá đang nằm trong hộp tính là có sẵn, còn lại xét con cao thứ n
     * (n = số con còn thiếu) trong bong bóng, càng cao càng ưu tiên. Trả về index trong items, -1 nếu không có.
     */
    pickItem(slot: Slot, allowUsed: boolean): number {
        let used = this.slotNode.getComponentsInChildren(Slot).filter(s => s != slot).map(s => s.thingType);
        let best = -1, bestScore = -Infinity;
        this.items.forEach((array, i) => {
            let type = array[0];
            if(!allowUsed && used.includes(type)) return;
            let need = array.length - this.boxes.filter(b => b.thing && b.thingType == type).length;
            let ys = this.things.filter(t => t.thingType == type)
                .map(t => (t.bubble ? t.bubble.node : t.node).worldPosition.y)
                .sort((a, b) => b - a);
            if(need > ys.length) return;
            let score = need <= 0 ? Infinity : ys[need - 1];
            if(best < 0 || score > bestScore) { best = i; bestScore = score; }
        });
        return best;
    }

    setSlotThingFromArray(slot: Slot) {
        slot.thingType = -1;
        let index = this.pickItem(slot, false);
        if(index < 0) index = this.pickItem(slot, true);
        let array = index < 0 ? undefined : this.items.splice(index, 1)[0];
        let thing: Thing = null;
        if(array) {
            thing = this.things.find(t => t.thingType == array[0]);
            if (!thing) thing = this.boxes.map(b => b.thing).find(t => t && t.thingType == array[0]);
        }

        if(array) {
            let key = array[0];
            slot.thingType = key;
            slot.setThingFrame(thing);    
            slot.added = 0;  
            slot.setLabel(array.length);
            let p = slot.node.getChildByName("Avatar").children[0];
            // if(!EDITOR_NOT_IN_PREVIEW) {
            //     let c = [...p.children];
            //     c.forEach(c => c.setParent(this.node, true));
            // }
            p.destroyAllChildren();
            p.removeAllChildren();
            
            let tt = pm.spawnType<Thing>(PoolType.Thing);
            tt.node.parent = p;
            slot.avatar = tt.node;
            tt.node.position = v3(0, 0, 0);
            tt.node.eulerAngles = v3(0, 0, 0);
            tt.node.scale = v3(1, 1, 1);
            tt.thingType = key;
            tt.node._objFlags = CCObjectFlags.DontSave;
            
            let fish = this.getSrc(key);
            let f = tt.getComponentInChildren(Fish)
            fish.parent = f.node;
            this.centerSrc(fish, key);
            fish.eulerAngles = v3(0, 0, 0);
            fish.scale = v3(1, 1, 1);
            fish.active = true;
            fish._objFlags = CCObjectFlags.DontSave;
            f.init();
            f.setAnim(false);

            tt.init(false);
            this.fitInTank(slot, fish, key);

        }
        // console.log("items length", this.items.length);

        return array != undefined;
    }

    // tỉ lệ cạnh lớn nhất của cá trong slot so với content size FishTank (chừa chỗ cho cá uốn thân)
    @property
    tankFill: number = 0.8;
    fishPoints: Map<number, Float32Array> = new Map();
    fishCenter: Map<number, Vec3> = new Map();

    /** Tâm mesh (AABB) của cá mẫu trong local SK_FishN - scale RootNode quanh gốc của nó sẽ làm tâm này lệch khỏi gốc. */
    getFishCenter(type: number) {
        if(this.fishCenter.has(type)) return this.fishCenter.get(type);
        let pts = this.getFishPoints(type);
        let c = v3();
        if(pts && pts.length) {
            let min = v3(Infinity, Infinity, Infinity), max = v3(-Infinity, -Infinity, -Infinity), p = v3();
            for(let i = 0; i < pts.length; i += 3) {
                p.set(pts[i], pts[i + 1], pts[i + 2]);
                Vec3.min(min, min, p);
                Vec3.max(max, max, p);
            }
            c.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
        }
        this.fishCenter.set(type, c);
        return c;
    }

    /**
     * Dời bản clone SK_FishN (rotation 0, scale 1 trong node Fish) để tâm mesh trùng gốc node Fish - tâm xoay / điểm
     * bay tới hộp, slot. Nhờ vậy chỉnh position / scale RootNode của cá mẫu thế nào cá cũng không bị lệch.
     */
    centerSrc(fish: Node, type: number) {
        let c = this.getFishCenter(type);
        fish.setPosition(-c.x, -c.y, -c.z);
    }

    /** AABB world (XY) của cá loại type nếu đặt theo worldMatrix m (đỉnh local SK_FishN). */
    projectedSize(type: number, m: Mat4): [number, number, Vec3] {
        let pts = this.getFishPoints(type);
        if(!pts || pts.length == 0) return [0, 0, null];
        let min = v3(Infinity, Infinity, Infinity), max = v3(-Infinity, -Infinity, -Infinity), p = v3();
        for(let i = 0; i < pts.length; i += 3) {
            p.set(pts[i], pts[i + 1], pts[i + 2]);
            Vec3.transformMat4(p, p, m);
            Vec3.min(min, min, p);
            Vec3.max(max, max, p);
        }
        return [max.x - min.x, max.y - min.y, v3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2)];
    }

    /**
     * Scale + dời cá (bản clone SK_FishN trong Avatar của slot) cho tâm mesh trùng tâm FishTank. Hệ số scale dùng chung
     * mọi loại đang chơi (loại to nhất vừa tankFill khung FishTank) nên tỉ lệ to/nhỏ giữa các loại giữ đúng như cá mẫu
     * - chỉnh scale RootNode của cá mẫu thì cá trong slot cũng to/nhỏ theo. Camera UI orthographic nên chỉ so trên XY.
     */
    fitInTank(slot: Slot, fish: Node, type: number) {
        let tank: Node = null;
        Ulis.allNode(slot.node, n => { if(!tank && /^FishTank/i.test(n.name)) tank = n; });
        let ut = tank?.getComponent(UITransform);
        if(!ut) return;

        let m = fish.worldMatrix;
        let [w, h, c] = this.projectedSize(type, m);
        if(!(w > 0 && h > 0)) return;

        let rect = ut.getBoundingBoxToWorld();
        let k = Infinity;
        this.fishTypes.forEach(t => {
            let [tw, th] = this.projectedSize(t, m);
            if(tw > 0 && th > 0) k = Math.min(k, rect.width / tw, rect.height / th);
        });
        k = this.tankFill * (isFinite(k) ? k : Math.min(rect.width / w, rect.height / h));
        // scale quanh gốc clone O: tâm c -> O + k (c - O), rồi dời để tâm về giữa FishTank
        let o = fish.worldPosition.clone();
        let cNew = Vec3.scaleAndAdd(v3(), o, Vec3.subtract(v3(), c, o), k);
        fish.setScale(k, k, k);
        fish.setWorldPosition(o.x + rect.center.x - cNew.x, o.y + rect.center.y - cNew.y, o.z);
    }

    /** Đỉnh mesh (đã skinning) của cá mẫu room.fish.children[type] trong local space của node SK_FishN, cache theo loại. */
    getFishPoints(type: number) {
        if(this.fishPoints.has(type)) return this.fishPoints.get(type);
        let sk = this.fish.children[type];
        let renderer = sk?.getComponentInChildren(SkinnedMeshRenderer) || sk?.getComponentInChildren(MeshRenderer);
        let pts = renderer?.mesh ? Room.meshPoints(renderer, Mat4.invert(new Mat4(), sk.worldMatrix)) : null;
        this.fishPoints.set(type, pts);
        return pts;
    }

    /**
     * a_position dạng float. GLB nén (KHR_mesh_quantization) lưu số nguyên 0..65535 -> readAttribute trả số thô;
     * giải nén tuyến tính từng trục về [minPosition, maxPosition] của mesh.
     */
    static readPositions(mesh: Mesh): ArrayLike<number> {
        let pos = mesh.readAttribute(0, gfx.AttributeName.ATTR_POSITION);
        if(!pos) return [];
        let s = mesh.struct;
        let bundle = s.vertexBundles[s.primitives[0].vertexBundelIndices[0]];
        let attr = bundle?.attributes.find(a => a.name == gfx.AttributeName.ATTR_POSITION);
        if(!attr || attr.format == 32 /* gfx.Format.RGB32F */ || !s.minPosition || !s.maxPosition) return pos;
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for(let i = 0; i < pos.length; i++) {
            let j = i % 3;
            lo[j] = Math.min(lo[j], pos[i]);
            hi[j] = Math.max(hi[j], pos[i]);
        }
        let min = [s.minPosition.x, s.minPosition.y, s.minPosition.z];
        let max = [s.maxPosition.x, s.maxPosition.y, s.maxPosition.z];
        let out = new Float32Array(pos.length);
        for(let i = 0; i < pos.length; i++) {
            let j = i % 3;
            out[i] = hi[j] > lo[j] ? min[j] + (pos[i] - lo[j]) / (hi[j] - lo[j]) * (max[j] - min[j]) : (min[j] + max[j]) / 2;
        }
        return out;
    }

    /** Đỉnh mesh sau skinning (CPU) theo pose hiện tại, mỗi đỉnh world nhân thêm ma trận `inv`. */
    static meshPoints(renderer: MeshRenderer, inv: Mat4): Float32Array {
        let mesh = renderer.mesh;
        let pos = Room.readPositions(mesh);
        let out = new Float32Array(pos.length);
        let n = 0;
        let v = v3(), acc = v3(), t = v3();
        let push = (p: Vec3) => {
            Vec3.transformMat4(p, p, inv);
            out[n++] = p.x; out[n++] = p.y; out[n++] = p.z;
        };
        let skel = renderer instanceof SkinnedMeshRenderer ? renderer.skeleton : null;
        if(skel) {
            let root = (renderer as SkinnedMeshRenderer).skinningRoot || renderer.node;
            let jts = mesh.readAttribute(0, gfx.AttributeName.ATTR_JOINTS);
            let wts = mesh.readAttribute(0, gfx.AttributeName.ATTR_WEIGHTS);
            let jm = skel.joints.map((path, i) => {
                let n = root.getChildByPath(path);
                let mat = new Mat4();
                if(n) Mat4.multiply(mat, n.worldMatrix, skel.bindposes[i]);
                return mat;
            });
            for(let i = 0; i < pos.length / 3; i++) {
                v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
                acc.set(0, 0, 0);
                for(let k = 0; k < 4; k++) {
                    let w = wts[i * 4 + k];
                    if(!w) continue;
                    Vec3.transformMat4(t, v, jm[jts[i * 4 + k]]);
                    Vec3.scaleAndAdd(acc, acc, t, w);
                }
                push(acc);
            }
        } else {
            for(let i = 0; i < pos.length / 3; i++) {
                v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
                Vec3.transformMat4(t, v, renderer.node.worldMatrix);
                push(t);
            }
        }
        return out;
    }

    initThings() {
        this.things = this.thingNode.getComponentsInChildren(Thing);
        this.total = this.things.length
        // console.log(this.thingNode.children.length);
        
        // this.items = this.things.map(t => new Array(t.thingType));
        this.things.sort((t1, t2) => t1.thingType - t2.thingType);
        this.things.forEach((thing) => {
            // thing.init();
            let type = thing.thingType;
            if(this.map.has(type)) {
                this.map.set(type, this.map.get(type) + 1);
            } else {
                this.map.set(type, 1);
            }
        })

        let items: number[][] = [];
        for( let [key, value] of this.map) {
            let array = new Array(3).fill(key);
            let amount = value / 3;
            for(let i = 0; i < amount; i++) {
                items.push(array);
            }
            // items.push(new Array(value).fill(key));
        }
        this.slots.forEach(slot => slot.thingType = -1);
        this.slots.forEach((slot) => {
            this.setSlotThingFromArray(slot);
        })
        items = Ulis.shuffleArray(items);
        if(EDITOR) {
            console.log(this.map);
            console.log(items);
        }

        try {
            if(!EDITOR_NOT_IN_PREVIEW) {
                // Tutorial: chỉ vào 3 con cao nhất của loại cá ở slot đầu
                let t0 = this.slots[0].thingType;
                let things = this.things.filter(t => t.thingType == t0);
                things.sort((a, b) => b.node.worldPosition.y - a.node.worldPosition.y);
                this.taps = things.map(t => t.node).slice(0, 3);
            }
            // .reverse();
            
        } catch (error) {
            
        }

        
        // let sprites = this.thingNode.getComponentsInChildren(Sprite);
        // sprites.forEach((sprite) => {
        //     let sc = sprite.node.scale.clone();
        //     sprite.node.scale = v3(1, 1, 1);
        //     let ui = sprite.getComponent(UITransform);
        //     let size = ui.contentSize.clone();
        //     size.width *= sc.x;
        //     size.height *= sc.y;
        //     ui.contentSize = size;

        // })
    }

    initSlots() {
        this.slots = this.slotNode.getComponentsInChildren(Slot);
        // this.slots.forEach((slot) => {
        //     slot.node.destroy();
        // })
        // this.slots = [];
        for(let i = 0; i < this.slotAmount; i++) {
            let slot = this.slots[i] ;
            slot.node.parent = this.slotNode;
            slot.node.position = v3(this.slotDis*(-this.slotAmount/2 + 0.5 + i));
            slot.initSlot();
            slot.node.name = "slot" + i;
        }
    }

    initBoxes() {
        this.boxes = this.boxNode.getComponentsInChildren(Slot);
        // this.boxes.forEach((slot) => {
        //     slot.node.destroy();
        // })
        // this.boxes = [];
        for(let i = 0; i < this.boxAmount; i++) {
            let box = this.boxes[i]
            box.node.parent = this.boxNode;
            box.node.position = v3(this.boxDis*(-this.boxAmount/2 + 0.5 + i));
            box.init();
            box.index = i;
            box.node.name = "box" + i;
        }

    }

    getBox(index: number) {
        return this.boxes.find(b => b.index == index);
    }

    onPickThing(thing: Thing) {
        this.things = this.things.filter(t => t != thing);
        this.taps = this.taps.filter(t => t != thing.node);
    }

    onTapThing(thing: Thing) {
        thing.offTouch();
        this.onFirst();
        this.onPickThing(thing);
        if(this.fisrtTapCount > 0) {
            this.tap(thing.node);
            this.fisrtTapCount--;
            if(this.fisrtTapCount == 0) {
                ui.offHand();
                if(this.tappable)
                this.taps = [];
                this.hint();
            }
        } else {
            ui.offHand();
            if(this.tappable)
            this.taps = [];
            this.hint();
        }
    }

    clicked: number = 0;
    onThing() {
        this.clicked++;
        // console.log(this.clicked, this.total);
        

        // let r = this.clicked/this.total;
        // r = Math.floor(r*100)
        // ui.onProgress(r);
        
        if(this.clicked >= this.maxPick) {            
            this.onBind();
        }
    }

    boxed: number = 0;
    pTween: Tween<any> = null;
    onBox() {
        this.boxed++;

        let r = this.boxed/this.totalBox;       
        console.log(this.boxed);
        
        ui.onProgress((Math.floor(r*100)));
        let time = r - this.progress;
        const t = this;
        this.pTween?.stop();
        this.pTween = tween(this.progressBar)
        .to(time, { fillRange: r }, { easing: "linear", 
            onUpdate(target, ratio) {
                t.progress = r;
            }
        })
        .start();
        if(this.boxed >= this.maxBox) {
            this.onBind();
        }
    }

    bound: boolean = false;
    onBind() {
        console.log("bind");
        
        this.bound = true;
        this.hintTween?.stop();
        ui.offHand();
        this.things.forEach((t) => t.offTouch());
        ui.bindingToStore();
    }


    checkBox(thing: Thing, wpos: Vec3) {
        if(!this.zoomed) return;
        let thingyType = thing.thingType;
        let slot = this.slots.find(s => s.thingType == thingyType);
        if(slot && slot.added + slot.queue.length < slot.maxAmount) {
            this.onThing();
            this.checkSlot(thing);
        } else {
            this.swapBox(thing);
            // this.checkFail(wpos);
        }
    }

    checkFail(pos: Vec3) {
        // this.onThing();
        // sm.playSound(SoundType.Wrong);
        // let x = pm.spawn(PoolType.X);
        // x.node.parent = this.vfxNode;
        // x.node.worldPosition = pos;
        // let s = x.node.children[0];
        // s.scale = v3(0.5, 0.5, 0.5);
        // tween(s)
        // .to(0.2, {scale: v3(1, 1, 1)}, {easing: 'smooth'})
        // .delay(0.5)
        // .call(() => {
        //     pm.despawn(x);
        // })
        // .start();
    }

    checkSlot(thing: Thing) {
        let thingyType = thing.thingType;
        let slot = this.slots.find(s => s.thingType == thingyType);
        if(!slot || slot.added + slot.queue.length >= slot.maxAmount) return;
        this.onTapThing(thing);
        slot.setThing(thing);
    }

    queueSlot(thing: Thing) {
        let thingyType = thing.thingType;
        let slot = this.slots.find(s => s.thingType == thingyType);
        if(!slot) return;
        if(!slot.enqueue(thing)) return;
        this.onTapThing(thing);
    }

    swapBox(thing: Thing) {
        let thingyType = thing.thingType;
        let index = this.boxes.findIndex(b => b.thingType < 0)
        if(index > -1) {
            this.onThing();
            let box = this.boxes[index];
            this.onTapThing(thing);
            // box.setThing(thing);
            // let thingyBoxes = this.boxes.filter(b => b.thingType == thingyType);
            // let length = thingyBoxes.length;
            // if( length > 0) {
            //     let si = thingyBoxes[length - 1].index;
            //     let lastBox = this.getBox(this.boxAmount - 1);
            //     if(si <  this.boxAmount - 1 && lastBox.thingType < 0) {
            //         for(let i = this.boxAmount - 1; i > si; i--) {
            //             let nexBox = this.getBox(i);
            //             if(nexBox.thingType < 0) {
            //                 continue;
            //             } else {
            //                 nexBox.swapIndex(this.getBox(i+1));
            //             }
            //         }
            //         this.getBox(si + 1).setThing(thing);
            //     } else {
            //         box.setThing(thing);
            //     }
            // } else {
            //     box.setThing(thing);
            // }
            // console.log(thing);
            
            box.setThing(thing);

        }
    }

    onFull(slot: Slot) {
        sm.playSound(SoundType.Done); 
        this.slots = this.slots.filter(s => s != slot);
        this.onBox();
        let original = slot.node.position.clone();
        let pos = slot.node.position.clone();
        pos.y = 750;
        slot.count = 0;
        tween(slot.node)
        .delay(0.2)
        .to(0.5, {position: pos}, {easing: cEasing("backIn", 1.3)})
        .call(() => {
            slot.label.node.active = false;
            slot.label.string = "0/" + slot.maxAmount;
            slot.fishMove.removeAllFishes();
            slot.things.forEach(t => {
                this.things = this.things.filter(th => th != t);
                t.onDespawn();
            });
            slot.things = [];
            let addNew = this.setSlotThingFromArray(slot);   
            if(addNew) {
                slot.label.node.active = true;
                tween(slot.node)
                .to(0.2, {position: original}, {easing: 'smooth'})
                .call(() => {
                    if(addNew) {
                        this.slots.push(slot);
                        this.slots.sort((a, b) => a.node.position.x - b.node.position.x);

                        let thingType = slot.thingType;

                        // let sameBoxes = this.boxes.filter(b => !b.moving && b.thing && b.thing.thingType == thingType)
                        // let things = sameBoxes.map(b => b.thing)   
                        // things = things.filter((t, i) => i < slot.amount - slot.added);   
                        // things.forEach((t, i) => {
                        //     slot.setThing(t);
                        // });
                        
                        this.onSchedule();

                        // let bMove = this.boxes.filter(b => b.moving)
                        // if(bMove.length > 0) {
                        //     bMove.forEach(b => {
                        //         b.onMoved = () => {
                        //             this.rearrangeBoxes(bMove);
                        //             b.onMoved = () => {}
                        //         }
                        //     })  
                        // }  else {
                        //     this.rearrangeBoxes(bMove);
                        // }
                            
                    }  
                    // this.checkLose();              
                })
                .start();  
            } else {
                console.log(this.items);
                
                return;
            }          
        })
        .start();
    }

    rearrangeBoxes(boxes: Slot[] = []) {
        if(this.boxes.length == 0) {
            return;
        }
        if(this.lose) return;
        let moving = this.boxes.filter(b => b.moving);
        if(moving.length > 0) {
            return;
        } else {
            boxes.forEach(b => {
                b.onMoved = () => {}
            })

            let emptyBox = null;
            for(let i = 0; i < this.boxAmount; i++) {
                let box = this.getBox(i);
                if(box.thingType < 0) {
                    let nextBox = this.getBox(i+1);
                    if(nextBox && nextBox.thingType >= 0) {
                        emptyBox = box;
                        break;
                    }
                }
            }
            if(!emptyBox) return;

            // console.log("arrange");
            

            let things = this.boxes.map(b => b.thing).filter(t => t);
            things.forEach(t => {
                t.box.onDespawnThing();
            });
            things.forEach(t => {
                this.queueSlot(t);
            });
            things = things.filter(t => !t.box && !t.waiting);

            
            things.forEach((t, i) => {
                let box = this.getBox(i);
                box.setThing(t);
            });
        }
    }


    click: boolean = false;
    onTouchStart(event: EventTouch) {
        if(!event) return;
        this.onTouchStart2(event);
        // Any touch after the opening tutorial hides the hint and restarts the 5s idle timer.
        if(this.fisrtTapCount <= 0 && this.tappable && !this.lose) {
            ui.offHand();
            this.taps = [];
            this.hint();
        }
        this.location = event.getUILocation();
        if(this.s1 == null) {
            this.s1 = this.location.clone();
        } else if(this.s2 == null) {
            this.s2 = this.location.clone();
        }
        if(this.s1 && this.s2) {
            return;
        }

        this.click = true;
        this.startPos = v3(this.location.x, this.location.y, 0);
    }

    zoomBy(delta: number) {
        // if(!this.zoomed) 
            return;
        let scale = this.thingNode.scale.x;
        scale += delta;
        scale = misc.clampf(scale, 0.4, this.maxScale);
        this.thingNode.scale = v3(scale, scale, scale);
        ui.keepTap();
    }

    onTouchMove(event: EventTouch) {

        // return;
        if(!event) return;
        if(event.getTouches().length < 2) this.onTouchMove2(event);
        
        
        let touches = event.getTouches();
        if(touches.length >= 2) {
            this.click = false;
        } else {
            // let pos = touches[0].getUILocation();
            // let dis = Vec2.distance(pos, this.location);
            // console.log(dis);
            
            // if(dis > 100) {
            //     this.click = false;
            // }
        }
                this.click = false;

        if(this.s1 && this.s2 && touches.length >= 2) {
            let e1 = touches[0].getUILocation();
            let e2 = touches[1].getUILocation();
            let sDis = this.s2.clone().subtract(this.s1).length();
            let eDis = e2.clone().subtract(e1).length();
            let scale = eDis - sDis;
            this.s1 = e1.clone();
            this.s2 = e2.clone();
            // console.log(scale);
            this.zoomBy(scale/3000);
            return;
        }


        if(!this.startPos) return;
        // return;
        let delta = event.getUIDelta();
        let dpos = this.thingNode.getPosition();
        this.thingNode.worldPosition = this.thingNode.getWorldPosition().add3f(delta.x, delta.y, 0);
        let tp = this.thingNode.position.clone();
        let maxX = this.thingNode.scale.x * this.maxMoveX;
        let maxY = this.thingNode.scale.y * (this.maxMoveY);
        tp.x = misc.clampf(tp.x, -maxX, maxX);
        tp.y = misc.clampf(tp.y, -maxY - 400, maxY - 200);
        // tp.y = dpos.y;
        ui.keepTap();
        this.thingNode.position = tp;
    }

    onTouchEnd(event: EventTouch) {
        if(!event) return;
        this.finishDragHighlight(event);
        this.startPos = null;
        let out = event.getUILocation();
        if(this.s1 && this.s2) {
            if(this.s1.equals(out)) {
                this.s1 = this.s2.clone();
            }
            this.startPos = v3(this.s1.x, this.s1.y, 0);
            this.s2 = null;
        } else if (this.s1) {
            this.s1 = null;
        }
        if(this.click) {
            let pos = event.getLocation();
            let wpos = ui.uiCam.screenToWorld(v3(pos.x, pos.y, 0));
        }
    }

    binding() {
        if(!ipm) return;
        ipm.bindingStart = this.onTouchStart.bind(this);
        ipm.bindingMove = this.onTouchMove.bind(this);
        ipm.bindingEnd = this.onTouchEnd.bind(this);
    }

    update(deltaTime: number) {
        this.checkBubbleCollisions();
    }
}


