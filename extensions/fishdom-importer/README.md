# Fishdom Fish Importer

Menu **Tool → Fishdom Fish Importer**. Đưa 1 con cá Fishdom (`FishdomFish/<tên>.fbx` + `<tên>.png`) vào game, làm đủ các bước như cá `SK_Fish*` có sẵn.

## Cần có

- Blender **4.5 trở lên** (FBX Fishdom là dạng ASCII, chỉ bộ import FBX mới của Blender đọc được). Nút **Detect** tự tìm trong `C:\Program Files\Blender Foundation`.
- Mở **PlayScene** trước khi Import (tool tìm node `Fish` chứa các `SK_Fish*` và component `Mats` trong scene đang mở).

## Cách dùng

1. **Blender**: đường dẫn `blender.exe`.
2. **Con cá**: thư mục FishdomFish rồi chọn file FBX. Khung bên dưới hiện ảnh con cá sau khi chuyển (Blender render, lần đầu mất ~10 giây, sau đó lấy từ cache `temp/fishdom-importer/preview`; nút ↻ để render lại).
   Texture: ưu tiên `<tên>.png`, không có thì lấy ảnh mà FBX tham chiếu (vd `harlequin2_fish_color.png`). Dòng cảnh báo màu cam khi thiếu ảnh (`clownfish_spinner`) hoặc cá dùng nhiều ảnh (`penguin`) - chỉ gộp được 1 texture.
3. **Đầu ra**: tên file GLB (mặc định `SK_Fish<số lớn nhất + 1>`), **Scale** nhân vào model (mặc định 45000).
4. **Slot**: node `SK_FishN` trong `Room > Fish` để đặt cá vào. Số N = loại cá (`room.fish.children[N]`), dùng số này trong `BubbleData`.
   Muốn thêm loại cá mới thì tạo sẵn 1 node rỗng cuối danh sách con của `Fish` (vd `SK_Fish20`), bấm ↻ rồi chọn nó.
5. Bấm **Import**.

## Tool làm gì

Kết quả cùng dạng với cá mẫu (`SK_Fish1..20`):

```
Assets:  SK_FishN.glb  ->  <Tên>.mesh, <Tên>_Rig.skeleton, SK_FishN.prefab   (không material / texture / animation)
Scene:   Room > Fish > SK_FishN (slot)
                         └─ RootNode            (+ FishAnimConfig nếu bake từ Unity)
                              ├─ <Tên>          SkinnedMeshRenderer, material trống, skinningRoot = slot
                              └─ <Tên>_Rig      Root > Spine_1 > ...
```
`<Tên>` = tên FBX bỏ `SK_` (SK_Fish21.fbx -> Fish21).

1. Blender (`scripts/convert.py`): gộp mesh, bỏ material, dựng lại cây `RootNode > <Tên> + <Tên>_Rig`, nhân scale vào vertex + xương, xuất GLB. Meta GLB bật meshOptimize / meshSimplify / meshCompress như file mẫu.
2. Copy GLB vào `assets/8.Models/Meshes/Fishes/<Tên GLB>.glb` (ghi đè nếu đã có, giữ nguyên .meta) và PNG vào `assets/8.Models/Textures/Fishes/<tên cá>.png` (chỉ copy nếu chưa có).
3. Trong scene (có undo):
   - xoá node con cũ của slot (nếu bật **Xoá con cũ của slot**);
   - tạo prefab của GLB làm con của slot, xoay 180° nếu đầu cá (bone `head`) đang hướng -Z;
   - dời để tâm mesh nằm đúng gốc slot;
   - để trống material slot 0: lúc chạy `Thing.setMeshMat()` gán material `Fish` (`room.mat.mats[N]`);
   - gán `Mats.textures[N]` = texture PNG;
   - lưu scene (nếu bật **Lưu scene**).

Trong editor cá sẽ hiện màu hồng tím và thiếu vây/đuôi vì chưa có material - vào game mới có material `Fish`.

## Fish Level Setup (Tool → Fish Level Setup)

Chọn cá được chơi trong level, không phải sửa tay scene / Room.ts:

- Lưới ảnh mọi `SK_FishN.glb` trong `Meshes/Fishes` (render bằng Blender, cache theo thời điểm sửa file). `SK_FishN.glb` = **loại N-1** = slot `SK_Fish<N-1>`
  (quy ước sẵn có: slot 19 = SK_Fish20.glb...). Texture: `T_<tên model>_D.png`, không có thì `T_FishN_D.png`.
- Thẻ hiện: loại, model, đã có trong slot chưa, đang chơi + số con trong BubbleData. Bấm để chọn / bỏ; **Chọn cá đang chơi** lấy theo `Room.fishTypes`.
- **Áp dụng**:
  1. tạo thêm slot `SK_FishN` nếu thiếu (cùng hướng + layer slot đầu);
  2. slot của con được chọn chưa đúng model -> đặt model như cá mẫu (`RootNode > <Tên> + <Tên>_Rig`, skinningRoot = slot, layer, canh tâm,
     material trống; GLB gốc PlayCanvas: RootNode scale 50); slot đã đúng thì giữ nguyên;
  3. (tuỳ chọn) dọn model ở slot không chọn;
  4. `MatCustom` (`Mats.textures[loại]`) + `Room.fishTypes`;
  5. (tuỳ chọn) **Gen bubble**: gọi `Room.randomFromAvailableBubbles(fishTypes)` - giữ vị trí + cỡ bubble đang có, chia lại loại cá theo nhóm 3;
     ghi `BubbleData` + `Items` (nhóm [t,t,t], xáo trộn) thẳng vào `Room.ts`, lưu scene rồi nạp lại để bubble hiện theo data mới.

## Bake từ project Unity (khuyên dùng)

Đổi thư mục thành gốc project Unity (vd `F:\AssetFish\FishSort-new-item`, có `Assets/` + `ProjectSettings/`). Tool tự quét mọi prefab
có component `*ProceduralAnimator` (~70 con: `Fish_1..43`, cá Fishdom, `Prop_*`) và lấy từ prefab:

- FBX nguồn (`PrefabInstance.m_SourcePrefab`) và texture (material override trong prefab, không có thì `externalObjects` trong `.meta` của FBX -> `.mat` -> `_BaseMap` / `_MainTex`);
- tên class animator + mọi field số (tham số animation đã chỉnh trong Inspector), `FishModel.Orientation`.

Khi Import vào slot, tham số được lưu vào component `FishAnimConfig` trên node model (Inspector xem / sửa được). `Fish.ts` đọc nó lúc `init()`:

- field trùng tên với property của `Fish` (`swayAngle`, `waveLength`, `finAngle`, `centerFinAngle`, `turnBend`...) ghi đè giá trị mặc định;
- `OctopusProceduralAnimator` / `CrabProceduralAnimator`: chạy `CreatureAnimator.ts` (port từ Unity) với tham số trong prefab.

Animator đã port: `FishRig`, `Fishdom` (qua `Fish.ts`), `Octopus`, `Crab`, `Starfish`, `Seahorse`, `Seal` (qua `CreatureAnimator.ts`,
engine = FishPoseJob nhánh Wave + SideFin). Loài khác (`Turtle`, `HermitCrab`, `Anglerfish`, `Prop`) log cảnh báo khi Import và tạm dùng
sóng thân cá. Không có FishAnimConfig thì bạch tuộc / cua / sao biển vẫn được nhận theo bone; cá ngựa / hải cẩu dùng rig cá chuẩn nên
cần config mới chạy đúng animator.

**Fish Level Setup** cũng gắn FishAnimConfig cho mọi slot được chọn (ô *Project Unity*): GLB được ghép với prefab Unity theo texture
(md5 giống file texture của prefab), GLB gốc PlayCanvas `SK_FishN` ghép với `Fish_N`. Loài có animator riêng giữ hướng gốc (mặt +Z) khi đặt vào slot.

## Model trong `Models/Fish Rig` (SK_Fish*.fbx, SK_Prop*.fbx)

Dùng được cùng tool: đổi thư mục thành `F:\AssetFish\Graphics\Graphics\Models\Fish Rig`.

- Texture tự tìm `Models/Texture/<X>/T_<X>_D.png` cho `SK_<X>.fbx` (normal map bị bỏ qua).
- Model cỡ ~1 đơn vị nên scale cần khoảng **5000–6500** (không phải 45000): chọn cá rồi bấm **Tự tính** sau khi ảnh xem trước hiện ra.
- Nhiều mesh (vd `SK_Fish21` thân + đầu) được gộp thành 1.
- Animation clip trong FBX được xuất kèm GLB (keyframe vị trí xương cũng được nhân theo scale). `Fish.ts`:
  - đủ xương thân (`Spine`/`Tail`/`body` ≥ 2): bơi procedural như cũ, clip bị tắt;
  - ít hơn (vd bạch tuộc `Models/Fish Rig/SK_Fish21.fbx`: `Spine_1` + `Arm_*`): phát clip kiểu ping-pong (xuôi rồi ngược), `setAnim(false/true)` dừng / chạy tiếp, `speed` đổi tốc độ clip.
    Ping-pong vì clip của rig gốc chỉ là nửa nhịp vẫy (Unity không import nó - `importAnimation: 0`), phát Loop sẽ giật mỗi lần quay về đầu.
  - Clip chỉ chạy khi Preview / build - trong Scene view của editor model đứng yên ở tư thế gốc.
- Tên GLB đừng trùng file đã có: `SK_Fish21.glb` trong project hiện là `african_jewelfish`.

## Lưu ý

- Cá bơi nhờ `Fish.ts` dò xương theo tên (quy ước Fishdom: `body#`, `tail#`, `tail_up/mid/dwn`, `*_front_fin#`, `*_side_plv_#`...). Con dùng rig khác (vd `penguin`) sẽ đứng yên; vài con có vây lưng/hậu môn đặt tên lạ thì vây đó không động.
- Con không có bone `head` thì tool không tự xoay được, cần kiểm tra hướng bằng tay.
- Chạy script Blender không qua editor:
  `blender -b --factory-startup --python scripts/convert.py -- <fbx> <png> <out.glb> [scale]`
