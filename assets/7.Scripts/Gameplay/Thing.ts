import { _decorator, Animation, color, Component, Enum, EventTouch, instantiate, Layers, Material, MeshRenderer, Node, Size, SkinnedMeshRenderer, sp, Sprite, SpriteFrame, Tween, tween, UIRenderer, UITransform, v3, Vec3 } from 'cc';
import { PoolMember } from '../Pool/PoolMember';
import { room } from './Room';
import Ulis from '../Misc/Ulis';
import { ui } from '../Manager/UI';
import { sm, SoundType } from '../Manager/SoundManager';
import { ipm } from '../Manager/InputManager';
import { Slot } from './Slot';
import { NodeOrder } from '../MatchAsset/NodeOrder';
import { Bubble } from './Bubble';
import { Fish } from './FishMove/Fish';
import { pm } from '../Pool/PoolManager';
const { ccclass, property, executeInEditMode } = _decorator;

@ccclass('Thing')
// @executeInEditMode(true)
export class Thing extends PoolMember {
    

    @property
    thingType: number = -1;
    box: Slot = null;
    slot: Slot = null;
    @property
    sfx: boolean = false;
    bubble: Bubble = null;
    @property({
        type: Enum(SoundType),
        visible() {
            return this.sfx;
        },
    })
    audio: SoundType = SoundType.Done;

    touch: Node = null;
    fish: Fish = null;
    inited: boolean = false;
    moving: boolean = false;
    waiting: boolean = false;
    init(toucable: boolean = true) {
        this.setMeshMat();
        if(this.inited) return;
        this.moving = false;
        this.inited = true;
        this.fish = this.getComponentInChildren(Fish);
        this.touch = this.node.getChildByName("Touch");
        toucable && this.onTouch();

    }

    setMeshMat() {        
        let mesh = this.getComponentInChildren(MeshRenderer);
        // console.log(mesh);
        // let mat = room.mat.getClone(this.thingType);
        let mat = room.mat.mats[this.thingType];
        // sharedMaterial, không dùng mesh.material: getter đó tạo material instance riêng, đè lên viền theo trạng thái
        mesh && !mesh.sharedMaterial && mesh.setSharedMaterial(mat, 0);
    }


    // Keep move/end handlers until the node that owns the touch finishes its gesture.
    offTouch() {
        if(!this.node) return;
        this.touch.off(Node.EventType.TOUCH_START, this.onDragStart, this);
        this.offHightlight();
    }

    onTouch() {
        this.touch.off(Node.EventType.TOUCH_START, this.onDragStart, this);
        this.touch.off(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.touch.off(Node.EventType.TOUCH_END, this.onDragEnd, this);
        this.touch.off(Node.EventType.TOUCH_CANCEL, this.onDragEnd, this);
        this.touch.on(Node.EventType.TOUCH_START, this.onDragStart, this);
        this.touch.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.touch.on(Node.EventType.TOUCH_END, this.onDragEnd, this);
        this.touch.on(Node.EventType.TOUCH_CANCEL, this.onDragEnd, this);
    }

    onDragStart(event: EventTouch) {
        room.onTouchStart2(event);
        if(room.dragCollect) {
            room.onTouchMove2(event);
            ipm.fisrtTap();
        } else {
            this.onTouchStart(event);
        }
    }

    onTouchMove(event: EventTouch) {
        room.onTouchMove2(event);
    }

    onDragEnd(event: EventTouch) {
        room.onTouchEnd2(event);
    }

    onDespawn() {
        let src = this.fish.node.children[0];
        room.despawnSrc(src);
        // pm.despawn(this);
        this.node.destroy();
    }

    onTouchStart(event: EventTouch) {
        let pos = event.getUILocation();
        let wpos = v3(pos.x, pos.y, 0);       
        room.checkBox(this, wpos);     
        ipm.fisrtTap();   
    }

    // đã được chọn bay lên slot: giữ viền vàng, highlight / bỏ highlight không được đổi lại
    toSlot: boolean = false;

    /** Viền theo trạng thái: selected = viền chọn (Mats.selectMats: màu + độ dày select), còn lại viền thường (Mats.mats). */
    setOutline(selected: boolean) {
        let m = selected ? room.mat.selectMats[this.thingType] : room.mat.mats[this.thingType];
        if(!m) return;
        this.getComponentsInChildren(MeshRenderer).forEach(r => r.setSharedMaterial(m, 0));
    }

    // highlight khi kéo qua = viền chọn; dùng material chung, không tạo material instance
    onHightlight() {
        this.setOutline(true);
    }

    offHightlight() {
        if(!this.toSlot) this.setOutline(false);
    }

    
    setUpLayer() {
        let l = Layers.nameToLayer("Particle");
        Ulis.allNode(this.node, (node) => node.layer = Math.pow(2, l));
    }

    setDownLayer() {
        let l = Layers.nameToLayer("UI_2D");
        Ulis.allNode(this.node, (node) => node.layer = Math.pow(2, l));
    }

    update(deltaTime: number) {
        if (this.touch && this.fish && this.fish.node) {
            let local = this.touch.parent.inverseTransformPoint(v3(), this.fish.node.worldPosition);
            this.touch.setPosition(local.x, local.y, this.touch.position.z);
        }
    }
}


