import { _decorator, Component, Node, toRadian, UITransform, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('Watermark')
export class Watermark extends Component {

    // @property
    speed: number = 200;

    tl: Node = null;
    tr: Node = null;
    bl: Node = null;
    br: Node = null;
    logo: Node = null;

    private dir: Vec3 = new Vec3();
    private tmpPos: Vec3 = new Vec3();

    start() {
        this.tl = this.node.getChildByName("TopLeft");
        this.tr = this.node.getChildByName("TopRight");
        this.bl = this.node.getChildByName("BottomLeft");
        this.br = this.node.getChildByName("BottomRight");
        this.logo = this.node.getChildByName("Logo");

        const angle = toRadian(45);
        this.dir.set(Math.cos(angle), Math.sin(angle), 0);
    }

    moveLogoInside(dt: number) {
        if(!this.tl || !this.tr || !this.bl || !this.br || !this.logo) return;

        const xs = [this.tl.position.x, this.tr.position.x, this.bl.position.x, this.br.position.x];
        const ys = [this.tl.position.y, this.tr.position.y, this.bl.position.y, this.br.position.y];

        let halfW = 0, halfH = 0;
        const ui = this.logo.getComponent(UITransform);
        if (ui) {
            const s = this.logo.scale;
            halfW = ui.width * Math.abs(s.x) * 0.5;
            halfH = ui.height * Math.abs(s.y) * 0.5;
        }

        const minX = Math.min(...xs) + halfW;
        const maxX = Math.max(...xs) - halfW;
        const minY = Math.min(...ys) + halfH;
        const maxY = Math.max(...ys) - halfH;

        const pos = this.tmpPos.set(this.logo.position);
        pos.x += this.dir.x * this.speed * dt;
        pos.y += this.dir.y * this.speed * dt;

        if (pos.x < minX) { pos.x = minX; this.dir.x = Math.abs(this.dir.x); }
        else if (pos.x > maxX) { pos.x = maxX; this.dir.x = -Math.abs(this.dir.x); }

        if (pos.y < minY) { pos.y = minY; this.dir.y = Math.abs(this.dir.y); }
        else if (pos.y > maxY) { pos.y = maxY; this.dir.y = -Math.abs(this.dir.y); }

        this.logo.setPosition(pos);
    }

    update(deltaTime: number) {
        this.moveLogoInside(deltaTime);
    }
}
