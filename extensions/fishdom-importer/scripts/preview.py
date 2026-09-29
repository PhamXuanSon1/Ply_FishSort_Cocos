"""
Render ảnh xem trước 1 con cá Fishdom (nhìn ngang, texture, nền trong suốt).

    blender -b --factory-startup --python preview.py -- <fbx|glb> <png> <out.png> [size]

Nhận cả FBX (nguồn) lẫn GLB đã import trong project (Fish Level Setup).
Vùng alpha < 0.5 của texture bị cắt bỏ giống material Fish (USE_ALPHA_TEST) trong game.
In ra dòng "RESULT {json}".
"""
import bpy, sys, os, json, mathutils

argv = sys.argv[sys.argv.index("--") + 1:]
fbx, png, out = argv[0], argv[1], argv[2]
size = int(argv[3]) if len(argv) > 3 else 512

bpy.ops.wm.read_factory_settings(use_empty=True)
if fbx.lower().endswith(('.glb', '.gltf')):
    bpy.ops.import_scene.gltf(filepath=fbx)
    # importer glTF tạo sẵn hình hiển thị bone (Icosphere) - không phải mesh của cá
    for o in [o for o in bpy.data.objects if o.type == 'MESH' and not any(m.type == 'ARMATURE' for m in o.modifiers) and o.name.startswith('Icosphere')]:
        bpy.data.objects.remove(o, do_unlink=True)
elif hasattr(bpy.ops.wm, "fbx_import"):
    bpy.ops.wm.fbx_import(filepath=fbx)
else:
    bpy.ops.import_scene.fbx(filepath=fbx)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']

import math, re
from mathutils import Vector, Matrix

# 1 material: texture qua BSDF (có khối sáng tối) + một phần emission cho màu tươi như trong game; alpha < 0.5 cắt bỏ
mat = bpy.data.materials.new("preview")
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
outn = nt.nodes.new('ShaderNodeOutputMaterial')
bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
bsdf.inputs['Roughness'].default_value = 0.55
if 'Emission Strength' in bsdf.inputs:
    bsdf.inputs['Emission Strength'].default_value = 0.35
if png and os.path.isfile(png):
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(png)
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    emit_in = bsdf.inputs.get('Emission Color') or bsdf.inputs.get('Emission')
    if emit_in: nt.links.new(tex.outputs['Color'], emit_in)
    clip = nt.nodes.new('ShaderNodeMath')
    clip.operation = 'GREATER_THAN'
    clip.inputs[1].default_value = 0.5
    nt.links.new(tex.outputs['Alpha'], clip.inputs[0])
    transp = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(clip.outputs[0], mix.inputs['Fac'])
    nt.links.new(transp.outputs[0], mix.inputs[1])
    nt.links.new(bsdf.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], outn.inputs['Surface'])
else:
    bsdf.inputs['Base Color'].default_value = (0.8, 0.3, 0.8, 1)
    nt.links.new(bsdf.outputs[0], outn.inputs['Surface'])
if hasattr(mat, "surface_render_method"):
    mat.surface_render_method = 'DITHERED'
elif hasattr(mat, "blend_method"):
    mat.blend_method = 'CLIP'
mat.use_backface_culling = False
for o in meshes:
    o.data.materials.clear()
    o.data.materials.append(mat)

# đỉnh mesh (đã skin) theo world
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
verts = []
for o in meshes:
    e = o.evaluated_get(dg)
    me = e.to_mesh()
    verts += [e.matrix_world @ v.co for v in me.vertices]
    e.to_mesh_clear()
if not verts:
    verts = [Vector((0, 0, 0)), Vector((1, 1, 1))]
mn = Vector([min(p[i] for p in verts) for i in range(3)])
mx = Vector([max(p[i] for p in verts) for i in range(3)])
center = (mn + mx) / 2
dim = mx - mn
UP = Vector((0, 0, 1))

# hướng mặt: cá bơi ngang (>= 2 xương thân + bone head) -> đầu theo bone head; loài khác (bạch tuộc, cua, sao biển,
# đồ vật) mặt về -Y Blender (= +Z glTF, cũng là hướng nhìn camera trong game)
arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
bones = list(arm.data.bones) if arm else []
body = [b for b in bones if re.match(r'^(Spine|Tail|body)_?\d+$', b.name, re.I)]
head = next((b for b in bones if b.name.lower() == 'head'), None)
front = None
fish = False
if arm and head and len(body) >= 2:
    # hướng đuôi -> đầu chỉ từ vị trí bone (GLB gốc PlayCanvas: bone có thể lệch scale so với mesh nên không so với tâm mesh)
    hp = arm.matrix_world @ head.head_local
    tail = max(body, key=lambda b: ((arm.matrix_world @ b.head_local) - hp).length)
    f = hp - (arm.matrix_world @ tail.head_local)
    f.z = 0
    if f.length > 1e-9:
        front = f.normalized()
        fish = True
if front is None:
    front = Vector((0, -1, 0))
side = UP.cross(front).normalized()

def view_dir(side_vec):
    if fish:   # 3/4: từ bên hông quay 35° về phía đầu, cao 15°
        yaw, elev = math.radians(35), math.radians(15)
        d = side_vec * math.cos(yaw) + front * math.sin(yaw)
    else:      # chính diện, lệch nhẹ 15°, cao 20°
        yaw, elev = math.radians(15), math.radians(20)
        d = front * math.cos(yaw) + side_vec * math.sin(yaw)
    return (d.normalized() * math.cos(elev) + UP * math.sin(elev)).normalized()

D = view_dir(side)
R = (-D).cross(UP).normalized()          # phải của khung hình
if fish and front.dot(R) > 0:            # đầu cá quay sang trái như icon
    side = -side
    D = view_dir(side)
    R = (-D).cross(UP).normalized()
U = R.cross(-D).normalized()             # trên của khung hình

# khung ortho ôm sát hình chiếu của mesh
xs = [(v - center).dot(R) for v in verts]
ys = [(v - center).dot(U) for v in verts]
cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
extent = max(max(xs) - min(xs), max(ys) - min(ys))
dist = dim.length * 3 + 1

cam_data = bpy.data.cameras.new("cam")
cam_data.type = 'ORTHO'
cam_data.ortho_scale = extent * 1.1
cam_data.clip_start = 0.001
cam_data.clip_end = dist * 3
cam = bpy.data.objects.new("cam", cam_data)
bpy.context.scene.collection.objects.link(cam)
rot = Matrix((R, U, D)).transposed()
cam.matrix_world = Matrix.Translation(center + R * cx + U * cy + D * dist) @ rot.to_4x4()
bpy.context.scene.camera = cam

# đèn: nắng chếch trên-trái-trước camera + ánh sáng môi trường xám
sun_data = bpy.data.lights.new("sun", 'SUN')
sun_data.energy = 3.0
sun = bpy.data.objects.new("sun", sun_data)
bpy.context.scene.collection.objects.link(sun)
light_dir = (D + UP * 0.9 - R * 0.6).normalized()     # hướng TỪ vật tới đèn
sun.rotation_euler = (-light_dir).to_track_quat('-Z', 'Y').to_euler()
world = bpy.data.worlds.new("w")
world.use_nodes = True
bg = world.node_tree.nodes.get('Background')
if bg:
    bg.inputs['Color'].default_value = (0.75, 0.75, 0.75, 1)
    bg.inputs['Strength'].default_value = 1.0
bpy.context.scene.world = world

scene = bpy.context.scene
engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
scene.render.engine = next((e for e in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT') if e in engines), 'CYCLES')
if scene.render.engine == 'CYCLES':
    scene.cycles.samples = 16
scene.render.film_transparent = True
scene.render.resolution_x = size
scene.render.resolution_y = size
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.view_settings.view_transform = 'Standard'
scene.render.filepath = out
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
bpy.ops.render.render(write_still=True)

print("RESULT " + json.dumps({"out": out, "engine": scene.render.engine, "size": [round(d, 4) for d in dim]}))
