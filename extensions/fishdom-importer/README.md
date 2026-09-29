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

1. Blender (`scripts/convert.py`): gộp mọi material thành 1 (texture nhúng), nhân scale vào vertex + xương, xuất GLB.
2. Copy GLB vào `assets/8.Models/Meshes/Fishes/<Tên GLB>.glb` (ghi đè nếu đã có, giữ nguyên .meta) và PNG vào `assets/8.Models/Textures/Fishes/<tên cá>.png` (chỉ copy nếu chưa có).
3. Trong scene (có undo):
   - xoá node con cũ của slot (nếu bật **Xoá con cũ của slot**);
   - tạo prefab của GLB làm con của slot, xoay 180° nếu đầu cá (bone `head`) đang hướng -Z;
   - dời để tâm mesh nằm đúng gốc slot;
   - để trống material slot 0: lúc chạy `Thing.setMeshMat()` gán material `Fish` (`room.mat.mats[N]`);
   - gán `Mats.textures[N]` = texture PNG;
   - lưu scene (nếu bật **Lưu scene**).

Trong editor cá sẽ hiện màu hồng tím và thiếu vây/đuôi vì chưa có material - vào game mới có material `Fish`.

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
