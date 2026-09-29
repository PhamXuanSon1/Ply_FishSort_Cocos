"""
Chuyển 1 con cá (FBX) sang GLB cho project FishSort, cùng dạng với các SK_Fish*.glb mẫu:

    RootNode
    ├─ <Tên>        mesh (skin), không material
    └─ <Tên>_Rig    khung xương (Root > Spine_1 > ...)

    <Tên> = tham số [base] (extension truyền tên GLB bỏ "SK_": SK_Fish24 -> Fish24);
    không truyền thì lấy tên FBX bỏ tiền tố "SK_" (SK_Fish21.fbx -> Fish21).
GLB chỉ có mesh + skeleton (không material, texture, animation clip): texture nằm riêng trong Textures/Fishes và được
gán qua Mats.textures[N]; material Fish do Thing.setMeshMat gán lúc chạy; cá bơi bằng Fish.ts / CreatureAnimator.ts.

Chạy bằng Blender (>= 4.5, cần bộ import FBX mới đọc được FBX ASCII của Fishdom):
    blender -b --factory-startup --python convert.py -- <fbx> <png (không dùng)> <out.glb> [scale] [base]

- Nhiều mesh (vd Fish21: thân + đầu) gộp thành 1.
- Nhân scale vào vertex + xương (apply transform) để RootNode có scale = 1. Mặc định 45000.
In ra dòng "RESULT {json}" để extension đọc.
"""
import bpy, sys, os, re, json

argv = sys.argv[sys.argv.index("--") + 1:]
fbx, out = argv[0], argv[2]
scale = float(argv[3]) if len(argv) > 3 else 45000.0
name = os.path.splitext(os.path.basename(fbx))[0]
base = argv[4] if len(argv) > 4 and argv[4] else re.sub(r'^SK_', '', name, flags=re.I)

bpy.ops.wm.read_factory_settings(use_empty=True)
if hasattr(bpy.ops.wm, "fbx_import"):
    bpy.ops.wm.fbx_import(filepath=fbx)       # importer mới (ufbx), đọc được FBX ASCII
else:
    bpy.ops.import_scene.fbx(filepath=fbx)    # Blender cũ: chỉ đọc FBX binary
clips = [a.name for a in bpy.data.actions]

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
# nhiều mesh -> gộp 1, vì Thing.setMeshMat chỉ gán material cho renderer đầu tiên
if len(meshes) > 1:
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in meshes:
    o.data.materials.clear()

# nhân scale vào dữ liệu: scale object gốc rồi apply cho tất cả
for o in bpy.data.objects:
    if o.parent is None:
        o.scale = o.scale * scale
        o.location = o.location * scale
bpy.context.view_layer.update()
arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
bpy.ops.object.select_all(action='SELECT')
bpy.context.view_layer.objects.active = arm or (meshes[0] if meshes else None)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bpy.context.view_layer.update()

# dựng lại cây như mẫu: RootNode > <Tên> (mesh) + <Tên>_Rig (armature), bỏ các empty trung gian của FBX
root = bpy.data.objects.new('RootNode', None)
bpy.context.scene.collection.objects.link(root)
keep = [o for o in meshes + ([arm] if arm else [])]
for o in keep:
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw
for o in list(bpy.data.objects):
    if o is not root and o not in keep:
        bpy.data.objects.remove(o, do_unlink=True)
for o in keep:
    o.parent = root
if arm:
    arm.name = base + '_Rig'
    arm.data.name = base + '_Rig'
if meshes:
    meshes[0].name = base
    meshes[0].data.name = base
bpy.context.view_layer.update()

pts = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
size = [max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3)] if pts else [0, 0, 0]
bones = [b.name for b in arm.data.bones] if arm else []

os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_skins=True, export_animations=False,
                          export_materials='NONE', export_texcoords=True, export_normals=True)

print("RESULT " + json.dumps({
    "name": name,
    "out": out,
    "size": [round(s, 1) for s in size],
    "meshes": len(meshes),
    "bones": len(bones),
    "boneNames": bones,
    "clips": clips,
    "tris": sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes),
}))
