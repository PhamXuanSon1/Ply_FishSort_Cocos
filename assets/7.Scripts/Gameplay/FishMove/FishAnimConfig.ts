import { _decorator, Component } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Tham số animation bake từ prefab Unity (FishSort-new-item, component *ProceduralAnimator), gắn trên node model
 * trong slot SK_FishN bởi tool Fishdom Fish Importer. Fish.build() đọc:
 *  - animator: tên class Unity (OctopusProceduralAnimator, CrabProceduralAnimator, FishRigProceduralAnimator,
 *    FishdomProceduralAnimator...) để chọn animator thay vì đoán theo tên bone;
 *  - params: các field số của component (tên giữ nguyên như Unity: swayAngle, armBias, legKick...).
 * Field trùng tên với property của Fish (swayFrequency, swayAngle, finAngle...) ghi đè giá trị trên Fish;
 * field riêng của bạch tuộc / cua do CreatureAnimator dùng.
 */
@ccclass('FishAnimConfig')
export class FishAnimConfig extends Component {
    @property({ tooltip: 'Class animator trong Unity' })
    animator = '';

    @property({ tooltip: 'Prefab Unity nguồn' })
    source = '';

    @property({ tooltip: 'FishModel.Orientation (Unity): 0 = theo hướng bơi, 1 = FaceCameraHeadFirst (mặt nhìn camera)...' })
    orientation = 0;

    @property({ multiline: true, tooltip: 'Field số của animator (JSON), tên giữ nguyên như Unity' })
    paramsJson = '{}';

    private cached: Record<string, number> | null = null;

    get params(): Record<string, number> {
        if (!this.cached) {
            try {
                const raw = JSON.parse(this.paramsJson || '{}');
                this.cached = {};
                for (const k of Object.keys(raw)) if (typeof raw[k] === 'number' && isFinite(raw[k])) this.cached[k] = raw[k];
            } catch (e) {
                console.warn(`FishAnimConfig '${this.node.name}': paramsJson không đọc được`, e);
                this.cached = {};
            }
        }
        return this.cached;
    }
}
