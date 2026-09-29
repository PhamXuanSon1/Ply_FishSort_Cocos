"""
Chuyển 1 con cá Fishdom (FBX + PNG) sang GLB cho project FishSort.

Chạy bằng Blender (>= 4.5, cần bộ import FBX mới đọc được FBX ASCII):
    blender -b --factory-startup --python convert.py -- <fbx> <png> <out.glb> [scale]

- Gộp mọi material slot thành 1 material (texture nhúng trong GLB) - project gán material Fish lúc chạy vào slot 0.
- Nhân scale vào vertex + xương (apply transform) để node gốc có scale = 1. Mặc định 45000.
- Giữ nguyên skin (xương) để Fish.ts tự animate; FBX Fishdom không có animation clip.
In ra dòng "RESULT {json}" để extension đọc.
"""
import bpy, sys, os, json

argv = sys.argv[sys.argv.index("--") + 1:]
fbx, png, out = argv[0], argv[1], argv[2]
scale = float(argv[3]) if len(argv) > 3 else 45000.0
name = os.path.splitext(os.path.basename(fbx))[0]

bpy.ops.wm.read_factory_settings(use_empty=True)
if hasattr(bpy.ops.wm, "fbx_import"):
    bpy.ops.wm.fbx_import(filepath=fbx)       # importer mới (ufbx), đọc được FBX ASCII
else:
    bpy.ops.import_scene.fbx(filepath=fbx)    # Blender cũ: chỉ đọc FBX binary

# 1 material, texture nhúng
mat = bpy.data.materials.new(name)
mat.use_nodes = True
nt = mat.node_tree
bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
if png and os.path.isfile(png):
    img = bpy.data.images.load(png)
    img.pack()
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
# nhiều mesh (vd Fish21: thân + đầu) -> gộp 1, vì Thing.setMeshMat chỉ gán material cho renderer đầu tiên
if len(meshes) > 1:
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in meshes:
    for p in o.data.polygons:
        p.material_index = 0
    o.data.materials.clear()
    o.data.materials.append(mat)

def action_fcurves(action):
    """fcurve của action - Blender 4.4+ dùng layered action (layers > strips > channelbags)."""
    if getattr(action, 'layers', None):
        return [fc for l in action.layers for s in l.strips for cb in s.channelbags for fc in cb.fcurves]
    return list(action.fcurves)

# nhân scale vào dữ liệu: scale object gốc rồi apply cho tất cả
for o in bpy.data.objects:
    if o.parent is None:
        o.scale = o.scale * scale
        o.location = o.location * scale
bpy.context.view_layer.update()
arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)

# apply làm xương to theo scale thế giới của armature, nhưng keyframe vị trí xương (đơn vị cũ) thì không -> nhân tay
if arm:
    k = arm.matrix_world.to_scale().x
    for action in bpy.data.actions:
        for fc in action_fcurves(action):
            if fc.data_path.endswith('.location'):
                for kp in fc.keyframe_points:
                    kp.co[1] *= k
                    kp.handle_left[1] *= k
                    kp.handle_right[1] *= k
                fc.update()

bpy.ops.object.select_all(action='SELECT')
bpy.context.view_layer.objects.active = arm or (meshes[0] if meshes else None)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bpy.context.view_layer.update()

pts = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
size = [max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3)] if pts else [0, 0, 0]
bones = [b.name for b in arm.data.bones] if arm else []

os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
# xuất cả animation clip (nếu FBX có): Fish.ts bơi procedural khi đủ xương thân, không đủ (vd bạch tuộc) thì phát clip này
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=True, export_skins=True)

print("RESULT " + json.dumps({
    "name": name,
    "out": out,
    "size": [round(s, 1) for s in size],
    "meshes": len(meshes),
    "bones": len(bones),
    "boneNames": bones,
    "clips": [a.name for a in bpy.data.actions],
    "tris": sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes),
}))
