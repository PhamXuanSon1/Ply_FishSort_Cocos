import { _decorator, CCObject, Color, color, Component, EventHandler, gfx, instantiate, JsonAsset, Material, MeshRenderer, Node, Texture2D, v2, v3, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('Mats')
export class Mats extends Component {

    @property({
        readonly: true,
        tooltip: "Click Recompile to apply changes. Click Demo to see model with applied materials. Click Log Data to export adjusted data to json file. Click Apply Data to load data from json file."
    })
    dragMouseHearToSeeGuide: boolean = false;

    get recompile() { return false; }
    @property 
    set recompile(v: boolean) {
        this.init();
        if(this.demo) {
            this.demo = true;
        }
    }

    _demo: boolean = false
    @property
    dis = v2(1, 1);
    get demo() { return this._demo; }
    @property 
    set demo(v: boolean) {
        if(!this.inited) this.init();
        this._demo = v;
        let parent = this.node.getChildByName("Demo");
        if(v == false) {
            if(parent) parent.active = false;
            return;
        } 

        let template = this.node.getChildByName("Template");
        let size = v2(this.colors.length, 10);
        if(template && parent) {
            parent.active = true;
            let meshes = [...parent.children];
            for(let i = 0; i < size.x; i++) {
                for(let j = 0; j < size.y; j++) {
                    let mesh = meshes.shift();
                    if(!mesh) mesh = instantiate(template);
                    mesh.parent = parent;
                    mesh.active = true;
                    mesh.position = v3((i - size.x/2 + 0.5) * this.dis.x, -j * this.dis.y);
                    mesh.name = "Color_" + i + "_index_" + j; 
                    mesh._objFlags = CCObject.Flags.DontSave 
                    | CCObject.Flags.HideInHierarchy;
                    // mesh.setSharedMaterial(this.mats[i], 0);
                    mesh.getComponentsInChildren(MeshRenderer).forEach(m => m.setSharedMaterial(this.mats[i], 0));
                }
            }
            meshes.forEach(m => m.destroy());
        }
    }

    @property
    fileName: string = "Box";
    get logData() { return false; }
    @property 
    set logData(v: boolean) {
        let keys = [
            "colors", 
            "clamBrightness", 
            "brightness", 
            "contrast", 
            "saturation", 
            "hue", 
            "roughness", 
            "metallic", 
            "specularIntensity", 
            "fixedLighting", 
            "selfEmissive", 
            "emissive", 
            "emissiveScale", 
            "useOutline", 
            "twoSided",
            "lineWidth",
            "selectLineWidth",
            "lineWidthScales",
            "dis"
        ]
        let data = {};
        keys.forEach(k => data[k] = this[k]);
        data["colors"] = this.colors.map(c => c.toHEX());
        data["emissive"] = this.emissive.toHEX();
        data["lineColor"] = this.lineColor.toHEX();
        data["selectLineColor"] = this.selectLineColor.toHEX();
        console.log(JSON.stringify(data));
        downloadJson(data, this.fileName + "MatData.json");
    }

    @property(JsonAsset)
    jsonData: JsonAsset = null!
    @property ({
        visible() {
            return this.jsonData !== null
        },
    })
    get applyData() { return false; }
    set applyData(v: boolean) {
        let keys = Object.keys(this.jsonData.json);
        keys.forEach(k => {
            this[k] = this.jsonData.json[k];
        });
        this.colors = this.jsonData.json["colors"].map(c => color().fromHEX(c));
        this.emissive = color().fromHEX(this.jsonData.json["emissive"]);
        if(this.jsonData.json["lineColor"]) this.lineColor = color().fromHEX(this.jsonData.json["lineColor"]);
        if(this.jsonData.json["selectLineColor"]) this.selectLineColor = color().fromHEX(this.jsonData.json["selectLineColor"]);
        this.dis = v2(this.jsonData.json["dis"].x, this.jsonData.json["dis"].y);
        this.init();
    }

    @property(Material)
    mat: Material = null!;
    mats: Material[] = [];
    @property
    useColor: boolean = true;
    @property({
        type: [Color],
        visible() {
            return this.useColor
        },
    })
    colors: Color[] = [];
    @property
    useTexture: boolean = false;
    @property({
        type: [Texture2D],

        visible() {
            return this.useTexture
        },
    })
    textures: Texture2D[] = [];    
    
    @property
    useNormalMap: boolean = false;
    @property({
        type: [Texture2D],

        visible() {
            return this.useNormalMap
        },
    })
    normalMaps: Texture2D[] = [];

    @property
    clamBrightness: boolean = true;  
    @property({slide: true, range: [-1, 1], step: 0.01})
    brightness: number = 0;
    @property({slide: true, range: [0, 2], step: 0.01})
    contrast: number = 0;
    @property({slide: true, range: [-10, 10], step: 0.01})
    saturation: number = 1;
    @property({slide: true, range: [-180, 180], step: 1})
    hue: number = 0;
    @property({slide: true, range: [0, 1], step: 0.01})
    roughness: number = 0.9;
    @property({slide: true, range: [0, 1], step: 0.01})
    metallic: number = 0.6;
    @property({slide: true, range: [0, 1], step: 0.01})
    specularIntensity: number = 1;
    @property
    fixedLighting: boolean = false;  
    @property({slide: true, range: [0, 10], step: 0.01, visible() {
        return this.fixedLighting
    },})
    light: number = 1;
    @property({slide: true, range: [0, 10], step: 0.01, visible() {
        return this.fixedLighting
    },})
    ao: number = 0.0;


    // emissive
    @property
    selfEmissive: boolean = false;  
    @property({visible() {
        return this.selfEmissive == false
    },})
    emissive: Color = color();
    @property({slide: true, range: [0, 10], step: 0.01})
    emissiveScale: number = 1;

    // glow
    @property
    enableGlow: boolean = false;  
    @property({visible() {
        return this.enableGlow
    }})
    selfGlow: boolean = false;
    @property({visible() {
        return this.selfGlow == false
    }})
    glowColor: Color = color();
    @property({slide: true, range: [-1, 1], step: 0.01})
    glowDark: number = 0;

    // outline
    @property
    useOutline: boolean = true;   
    // vây / đuôi là mặt phẳng hở (vd Fish27, Fish28): pass chính cull back nên nhìn từ sau chỉ còn pass outline
    // (vẽ mặt sau) -> mảng đen. Bật: pass chính vẽ 2 mặt + USE_TWOSIDE, pass outline giữ nguyên
    @property({tooltip: "Vẽ 2 mặt cho pass chính - sửa vây/đuôi bị đen ở model có mặt phẳng hở"})
    twoSided: boolean = true;

    // viền lúc bình thường: cá trong bong bóng, hộp chờ, slot (không được chọn). Độ dày tính bằng pixel màn hình
    // (shader đẩy viền theo pixel) nên đều nhau với mọi model / mọi cỡ
    @property({slide: true, range: [0, 20], step: 0.1, tooltip: "Độ dày viền lúc bình thường (pixel)", visible() {
        return this.useOutline
    },})
    lineWidth: number = 2;
    @property({tooltip: "Màu viền lúc bình thường", visible() {
        return this.useOutline
    },})
    lineColor: Color = color(0, 0, 0, 255);
    // viền khi cá được chọn và bay lên slot
    @property({slide: true, range: [0, 20], step: 0.1, tooltip: "Độ dày viền khi cá được chọn bay lên slot (pixel)", visible() {
        return this.useOutline
    },})
    selectLineWidth: number = 3;
    @property({tooltip: "Màu viền khi cá được chọn bay lên slot", visible() {
        return this.useOutline
    },})
    selectLineColor: Color = color(255, 204, 0, 255);
    // hệ số độ dày viền theo loại cá (index = loại cá, như colors / textures), nhân vào cả lineWidth lẫn
    // selectLineWidth. Thiếu phần tử = 1; init() tự nới mảng cho đủ số loại để chỉnh trên Inspector
    @property({type: [Number], tooltip: "Hệ số độ dày viền theo loại cá (index = loại cá). 1 = giữ nguyên, 0 = tắt viền loại đó", visible() {
        return this.useOutline
    },})
    lineWidthScales: number[] = [];
    // material khi được chọn, song song với mats (cùng index = loại cá), chỉ khác màu + độ dày viền
    selectMats: Material[] = [];

    @property([Material])
    defaultMats: Material[] = [];

    changeColor() {
        console.log("set color to mats");        
        this.mats.forEach((m, i) => {
            this.changeMat(m, i);            
        });
        this.selectMats.forEach((m, i) => {
            this.changeMat(m, i, true);
        });
        
    }

    getClone(i: number, selected: boolean = false) {
        let m = new Material();
        // custom define-marcos
        let info: any = {
            defines: {
                // độ dày 0 (vd lineWidthScales[i] = 0) = bỏ hẳn pass viền, không vẽ gì
                USE_OUTLINE_PASS: this.useOutline && (selected ? this.selectLineWidth : this.lineWidth) * (this.lineWidthScales[i] ?? 1) > 0,
                FIXED_LIGHTING : this.fixedLighting,
                CLAMP_BRIGHTNESS : this.clamBrightness,
                ENABLE_GLOW: this.enableGlow,
                USE_ALBEDO_MAP: this.useTexture && this.textures[i] !== undefined,
                USE_NORMAL_MAP: this.useNormalMap && this.normalMaps[i] !== undefined,
                // pass viền đọc alpha texture cá: vây cắt hình bằng alpha thì phần trong suốt không vẽ viền
                USE_BASE_COLOR_MAP: this.useTexture && !!this.textures[i],
            }
        };
        m.copy(this.mat, info);
        if(this.twoSided) {
            // biết danh sách pass (phụ thuộc defines) rồi mới gán state: bỏ cull mọi pass trừ pass outline
            info.defines.USE_TWOSIDE = true;
            info.states = m.passes.map(p => String(p.program).indexOf('silhouette-edge') >= 0
                ? {} : { rasterizerState: { cullMode: gfx.CullMode.NONE } });
            m.copy(this.mat, info);
        }
        this.changeMat(m, i, selected);
        return m;
    }

    changeMat(m: Material, i: number, selected: boolean = false) {
        m.setProperty("brightness", this.brightness);
        m.setProperty("contrast", this.contrast);
        m.setProperty("saturation", this.saturation);
        m.setProperty("hue", this.hue);
        m.setProperty("light", this.light);
        m.setProperty("ao", this.ao);

        let c = this.colors[i] ? this.colors[i].clone() : color();
        if(this.useColor && this.colors[i]) {
            m.setProperty("mainColor", c)
        }
        // outline: màu + độ dày theo trạng thái (bình thường / được chọn)
        m.setProperty("baseColor", selected ? this.selectLineColor : this.lineColor);

        if(this.useTexture) {
            this.textures[i] && m.setProperty("mainTexture", this.textures[i]);
            // chỉ khi material có pass viền (độ dày 0 thì không có pass này)
            if(this.textures[i] && m.passes.some(p => String(p.program).indexOf("silhouette-edge") >= 0)) m.setProperty("baseColorMap", this.textures[i]);
        }

        if(this.useNormalMap) {
            this.normalMaps[i] && m.setProperty("normalMap", this.normalMaps[i]);
        }

        m.setProperty("roughness", this.roughness);
        m.setProperty("metallic", this.metallic);
        m.setProperty("specularIntensity", this.specularIntensity);

        m.setProperty("emissiveScale", v3(1, 1, 1).multiplyScalar(this.emissiveScale));
        let em = this.selfEmissive ? c : this.emissive;
        m.setProperty("emissive", em);

        let gl = this.selfGlow ? c.clone() : this.glowColor.clone();
        let ad = AdjustSaturation(v3(gl.r / 255, gl.g / 255, gl.b / 255), this.saturation).multiplyScalar(255);
        gl = color(ad.x, ad.y, ad.z, 255);

        gl.r += this.glowDark * 255;
        if(gl.r > 255) gl.r = 255; 
        if(gl.r < 0) gl.r = 0;
        gl.g += this.glowDark * 255;
        if(gl.g > 255) gl.g = 255;
        if(gl.g < 0) gl.g = 0;
        gl.b += this.glowDark * 255;
        if(gl.b > 255) gl.b = 255;
        if(gl.b < 0) gl.b = 0;
        m.setProperty("glowColor", gl);

        let scale = this.lineWidthScales[i] ?? 1;
        m.setProperty("lineWidth", (selected ? this.selectLineWidth : this.lineWidth) * scale);
    }

    inited: boolean = false;
    @property([EventHandler])
    onColorChangeds: EventHandler[] = [];
    init(colors: Color[] = this.colors) {
        this.colors = colors;
        this.inited = true;
        this.mats = [];
        this.selectMats = [];
        // lấy MAX trong các nguồn đang bật, không phải ưu tiên 1 nguồn - nếu bật cả useColor lẫn useTexture mà
        // 2 mảng dài ngắn khác nhau thì vẫn phải tạo đủ material để phủ hết nguồn dài nhất.
        let length = Math.max(
            this.useColor ? this.colors.length : 0,
            this.useTexture ? this.textures.length : 0,
            this.useNormalMap ? this.normalMaps.length : 0,
        );
        while(this.lineWidthScales.length < length) this.lineWidthScales.push(1);
        for (let i = 0; i < length; i++) {
            let m = this.getClone(i);
            this.mats.push(m);
            this.selectMats.push(this.getClone(i, true));
        }
        if(this.inited) {
            this.onColorChangeds.forEach((e) => e.emit([]));
        } 

        // let keys = Object.keys(this);
        // console.log(keys);
        // this.logData = true;
        
    }

    update(deltaTime: number) {
        
    }
}

export function AdjustSaturation(color: Vec3, sat: number) {
    let gray = Vec3.dot(color, v3(0.299, 0.587, 0.114));
    // return mix(vec3(gray), color, sat);
    return Vec3.lerp(v3(), v3(gray, gray, gray), color, sat);
}


function downloadJson(data: any, fileName: string = "data.json") {
    const jsonString = JSON.stringify(data, null, 2);

    const blob = new Blob([jsonString], {
        type: "application/json"
    });

    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.style.display = "none";

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
}
