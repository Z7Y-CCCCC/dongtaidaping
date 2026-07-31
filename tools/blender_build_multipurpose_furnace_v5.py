"""Build the commercial-safe V5 multipurpose furnace asset inside Blender.

This script is meant to run in the already-open Blender process through the
local Blender MCP execute_code command. It only mutates the V5 working .blend
copy; the checked-in V4 source asset remains untouched.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
from array import array
from pathlib import Path

import bpy
from mathutils import Vector


WORKSPACE = Path(__file__).resolve().parents[1]
MODEL_DIR = WORKSPACE / "backend" / "assets" / "models"
TEXTURE_DIR = WORKSPACE / "backend" / "assets" / "textures" / "industrial"
OUTPUT_GLB = MODEL_DIR / "photo_multipurpose_furnace_v5.glb"
OUTPUT_PREVIEW = MODEL_DIR / "photo_multipurpose_furnace_v5_preview.png"
OUTPUT_REPORT = MODEL_DIR / "photo_multipurpose_furnace_v5_report.json"
WORKING_BLEND = MODEL_DIR / "photo_equipment_models_v5_quality.blend"

SOURCE_ROOT_NAME = "photo_multipurpose_furnace_v4_root"
TARGET_ROOT_NAME = "photo_multipurpose_furnace_v5_root"
FRONT_DOOR_ASSEMBLY = "multi_v5_front_door_assembly"

FRONT_DOOR_PARTS = (
    "multi_front_heat_door_black_panel",
    "multi_v2_front_door_inner_glow_panel",
    "multi_v3_front_door_refractory_inner",
    "multi_v4_front_flat_black_inner_door",
    "multi_v2_black_door_handle",
    "multi_v3_front_door_handle_bar",
    "multi_v3_front_door_handle_mount_a",
    "multi_v3_front_door_handle_mount_b",
)

ANIMATED_TARGETS = (
    FRONT_DOOR_ASSEMBLY,
    "multi_middle_door_reference",
    "multi_v4_roof_circulation_fan_01",
    "multi_v4_roof_circulation_fan_02",
    "multi_v4_oil_agitator_shaft_01",
    "multi_v4_oil_agitator_shaft_02",
    "multi_v4_oil_agitator_shaft_03",
    "multi_v4_oil_agitator_shaft_04",
)

PAINT_TEXTURE_MATERIALS = {
    "photo_panel_warm_white": 0.11,
    "photo_paint_white": 0.11,
    "photo_light_gray": 0.10,
    "photo_v3_paint_edge_highlight": 0.08,
    "photo_motor_green_gray": 0.08,
    "photo_motor_blue": 0.08,
    "photo_safety_yellow": 0.07,
    "photo_gas_pipe_yellow": 0.06,
}

MATERIAL_TUNING = {
    "photo_panel_warm_white": {"metallic": 0.04, "roughness": 0.38},
    "photo_paint_white": {"metallic": 0.04, "roughness": 0.38},
    "photo_light_gray": {"metallic": 0.05, "roughness": 0.42},
    "photo_v3_paint_edge_highlight": {"metallic": 0.05, "roughness": 0.34},
    "photo_v3_stainless_pipe": {"metallic": 0.92, "roughness": 0.23},
    "photo_brushed_steel": {"metallic": 0.88, "roughness": 0.28},
    "photo_v2_dark_bolt": {"metallic": 0.72, "roughness": 0.34},
    "photo_v3_brass_fittings": {"metallic": 0.82, "roughness": 0.30},
    "photo_v2_copper_brass": {"metallic": 0.78, "roughness": 0.31},
    "photo_v2_black_rubber": {"metallic": 0.0, "roughness": 0.82},
    "photo_v3_rubber_hose": {"metallic": 0.0, "roughness": 0.84},
    "photo_v4_blackened_oil_and_heat": {"metallic": 0.05, "roughness": 0.68},
}

EMISSIVE_MATERIALS = {
    "photo_v3_subtle_heat_glow": 2.0,
    "photo_hmi_screen": 0.45,
    "photo_signal_red": 0.65,
    "photo_signal_green": 0.65,
}


def descendants(root: bpy.types.Object) -> list[bpy.types.Object]:
    result: list[bpy.types.Object] = []
    pending = list(root.children)
    while pending:
        obj = pending.pop()
        result.append(obj)
        pending.extend(obj.children)
    return result


def recursive_set(root: bpy.types.Object) -> set[bpy.types.Object]:
    return {root, *descendants(root)}


def find_input(node: bpy.types.Node, *names: str):
    wanted = {name.lower() for name in names}
    for socket in node.inputs:
        if socket.name.lower() in wanted or socket.identifier.lower() in wanted:
            return socket
    return None


def principled(material: bpy.types.Material):
    if not material.use_nodes:
        material.use_nodes = True
    return next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)


def set_input_value(node, names: tuple[str, ...], value) -> None:
    socket = find_input(node, *names)
    if socket is not None:
        socket.default_value = value


def unlink_input(material: bpy.types.Material, socket) -> None:
    if socket is None:
        return
    for link in list(socket.links):
        material.node_tree.links.remove(link)


def source_material_name(name: str) -> str:
    return re.sub(r"_v5q(?:\.\d+)?$", "", name)


def stable_texture_name(image_name: str) -> str:
    stem = Path(image_name).stem
    suffix = Path(image_name).suffix.lower() or ".jpg"
    if stem.endswith("_1k"):
        return f"{stem}{suffix}"
    return f"{stem}_1k{suffix}"


def workspace_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(WORKSPACE.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def save_image_copy(image: bpy.types.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    current = Path(bpy.path.abspath(image.filepath)) if image.filepath else None
    if current and current.exists() and current.resolve() == destination.resolve():
        return
    image.filepath_raw = str(destination)
    if destination.suffix.lower() in {".jpg", ".jpeg"}:
        image.file_format = "JPEG"
    elif destination.suffix.lower() == ".png":
        image.file_format = "PNG"
    image.save()


def persist_polyhaven_assets() -> dict[str, str]:
    TEXTURE_DIR.mkdir(parents=True, exist_ok=True)
    output: dict[str, str] = {}

    for image in list(bpy.data.images):
        if not image.name.startswith("blue_metal_plate_"):
            continue
        destination = TEXTURE_DIR / stable_texture_name(image.name)
        save_image_copy(image, destination)
        output[image.name] = workspace_relative(destination)

    world = bpy.context.scene.world
    environment_image = None
    if world and world.use_nodes:
        environment_node = next(
            (node for node in world.node_tree.nodes if node.type == "TEX_ENVIRONMENT" and node.image),
            None,
        )
        if environment_node:
            environment_image = environment_node.image

    if environment_image:
        destination = TEXTURE_DIR / "blocky_photo_studio_1k.hdr"
        source = Path(bpy.path.abspath(environment_image.filepath)) if environment_image.filepath else None
        if source and source.exists() and source.resolve() != destination.resolve():
            shutil.copy2(source, destination)
        elif not destination.exists():
            environment_image.filepath_raw = str(destination)
            environment_image.file_format = "HDR"
            environment_image.save()
        environment_image.filepath = str(destination)
        if not environment_image.packed_file:
            environment_image.pack()
        output[environment_image.name] = workspace_relative(destination)

    return output


def make_subtle_roughness(source: bpy.types.Image) -> bpy.types.Image:
    name = "blue_metal_plate_roughness_subtle_1k.jpg"
    existing = bpy.data.images.get(name)
    if existing:
        return existing

    width, height = source.size
    pixels = array("f", [0.0]) * (width * height * 4)
    source.pixels.foreach_get(pixels)
    for index in range(0, len(pixels), 4):
        value = max(0.0, min(1.0, pixels[index]))
        value = 0.32 + value * 0.32
        pixels[index] = value
        pixels[index + 1] = value
        pixels[index + 2] = value
        pixels[index + 3] = 1.0

    image = bpy.data.images.new(name, width=width, height=height, alpha=False, float_buffer=False)
    image.colorspace_settings.name = "Non-Color"
    image.pixels.foreach_set(pixels)
    image.update()
    destination = TEXTURE_DIR / name
    save_image_copy(image, destination)
    image.pack()
    return image


def texture_images() -> tuple[bpy.types.Image, bpy.types.Image]:
    normal = next(
        (image for image in bpy.data.images if image.name.lower().startswith("blue_metal_plate_nor_gl")),
        None,
    )
    rough = next(
        (image for image in bpy.data.images if image.name.lower().startswith("blue_metal_plate_rough")),
        None,
    )
    if normal is None or rough is None:
        raise RuntimeError("Poly Haven blue_metal_plate normal/roughness maps are not loaded")
    normal.colorspace_settings.name = "Non-Color"
    rough.colorspace_settings.name = "Non-Color"
    return normal, make_subtle_roughness(rough)


def duplicate_root_materials(root: bpy.types.Object) -> dict[str, bpy.types.Material]:
    copied: dict[bpy.types.Material, bpy.types.Material] = {}
    by_source_name: dict[str, bpy.types.Material] = {}
    for obj in descendants(root):
        if obj.type != "MESH":
            continue
        for slot in obj.material_slots:
            material = slot.material
            if material is None:
                continue
            if material not in copied:
                clone = material.copy()
                clone.name = f"{source_material_name(material.name)}_v5q"
                copied[material] = clone
                by_source_name[source_material_name(material.name)] = clone
            slot.material = copied[material]
    return by_source_name


def add_paint_micro_surface(material: bpy.types.Material, normal_image, roughness_image, strength: float) -> None:
    bsdf = principled(material)
    if bsdf is None:
        return
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    roughness_socket = find_input(bsdf, "Roughness")
    normal_socket = find_input(bsdf, "Normal")
    unlink_input(material, roughness_socket)
    unlink_input(material, normal_socket)

    tex_coord = nodes.new("ShaderNodeTexCoord")
    tex_coord.name = "V5 Micro Surface UV"
    mapping = nodes.new("ShaderNodeMapping")
    mapping.name = "V5 Micro Surface Scale"
    mapping.vector_type = "TEXTURE"
    scale_socket = find_input(mapping, "Scale")
    if scale_socket is not None:
        scale_socket.default_value = (3.5, 3.5, 3.5)

    rough_tex = nodes.new("ShaderNodeTexImage")
    rough_tex.name = "V5 Paint Roughness"
    rough_tex.image = roughness_image
    rough_tex.interpolation = "Linear"

    normal_tex = nodes.new("ShaderNodeTexImage")
    normal_tex.name = "V5 Paint Normal"
    normal_tex.image = normal_image
    normal_tex.interpolation = "Linear"

    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.name = "V5 Subtle Paint Normal"
    set_input_value(normal_map, ("Strength",), strength)

    links.new(tex_coord.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], rough_tex.inputs["Vector"])
    links.new(mapping.outputs["Vector"], normal_tex.inputs["Vector"])
    links.new(rough_tex.outputs["Color"], roughness_socket)
    links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], normal_socket)


def tune_materials(materials: dict[str, bpy.types.Material]) -> None:
    normal_image, roughness_image = texture_images()
    for source_name, material in materials.items():
        bsdf = principled(material)
        if bsdf is None:
            continue
        tuning = MATERIAL_TUNING.get(source_name, {})
        if "metallic" in tuning:
            set_input_value(bsdf, ("Metallic",), tuning["metallic"])
        if "roughness" in tuning:
            set_input_value(bsdf, ("Roughness",), tuning["roughness"])
        if source_name in PAINT_TEXTURE_MATERIALS:
            add_paint_micro_surface(
                material,
                normal_image,
                roughness_image,
                PAINT_TEXTURE_MATERIALS[source_name],
            )
        if source_name in EMISSIVE_MATERIALS:
            base_socket = find_input(bsdf, "Base Color")
            emission_socket = find_input(bsdf, "Emission Color", "Emission")
            strength_socket = find_input(bsdf, "Emission Strength")
            if base_socket is not None and emission_socket is not None:
                emission_socket.default_value = base_socket.default_value
            if strength_socket is not None:
                strength_socket.default_value = EMISSIVE_MATERIALS[source_name]


def apply_modifiers(root: bpy.types.Object) -> None:
    for obj in descendants(root):
        if obj.type != "MESH" or not obj.modifiers:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        obj.hide_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        for modifier in list(obj.modifiers):
            try:
                bpy.ops.object.modifier_apply(modifier=modifier.name)
            except Exception as exc:
                print(f"V5 modifier warning: {obj.name}/{modifier.name}: {exc}")


def build_front_door_assembly(root: bpy.types.Object) -> bpy.types.Object:
    existing = bpy.data.objects.get(FRONT_DOOR_ASSEMBLY)
    if existing:
        return existing
    assembly = bpy.data.objects.new(FRONT_DOOR_ASSEMBLY, None)
    assembly.empty_display_type = "PLAIN_AXES"
    assembly.empty_display_size = 0.25
    bpy.context.scene.collection.objects.link(assembly)
    assembly.parent = root
    bpy.context.view_layer.update()
    for name in FRONT_DOOR_PARTS:
        obj = bpy.data.objects.get(name)
        if obj is None:
            raise RuntimeError(f"Missing front-door animation node: {name}")
        world_matrix = obj.matrix_world.copy()
        obj.parent = assembly
        obj.matrix_world = world_matrix
    root["front_door_parenting_fixed"] = True
    return assembly


def fix_legacy_front_door_parenting(root: bpy.types.Object) -> None:
    """Repair the first MCP build where the new empty was linked too late.

    In that interrupted in-memory build the door children retained world-space
    translations as local transforms, so moving the model root applied the
    overview offset twice. New clean builds never enter this branch.
    """
    if root.get("front_door_parenting_fixed"):
        return
    assembly = bpy.data.objects.get(FRONT_DOOR_ASSEMBLY)
    if assembly is None:
        return
    inverse_root = root.matrix_world.inverted()
    for child in assembly.children:
        child.matrix_local = inverse_root @ child.matrix_local
    root["front_door_parenting_fixed"] = True
    bpy.context.view_layer.update()


def dynamic_object_set() -> set[bpy.types.Object]:
    result: set[bpy.types.Object] = set()
    for name in ANIMATED_TARGETS:
        target = bpy.data.objects.get(name)
        if target is None:
            raise RuntimeError(f"Missing V5 animation target: {name}")
        result.update(recursive_set(target))
    return result


def slug(value: str) -> str:
    value = source_material_name(value).lower()
    value = re.sub(r"[^a-z0-9]+", "_", value).strip("_")
    return value or "material"


def join_group(objects: list[bpy.types.Object], name: str) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    active = objects[0]
    bpy.context.view_layer.objects.active = active
    if len(objects) > 1:
        bpy.ops.object.join()
    active.name = name
    try:
        bpy.ops.object.material_slot_remove_unused()
    except Exception:
        pass
    active.data.name = f"{name}_mesh"
    return active


def merge_static_by_material(root: bpy.types.Object) -> list[bpy.types.Object]:
    dynamic_objects = dynamic_object_set()
    groups: dict[bpy.types.Material | None, list[bpy.types.Object]] = {}
    for obj in descendants(root):
        if obj.type != "MESH" or obj in dynamic_objects:
            continue
        material = obj.material_slots[0].material if obj.material_slots else None
        groups.setdefault(material, []).append(obj)

    merged: list[bpy.types.Object] = []
    for index, (material, objects) in enumerate(
        sorted(groups.items(), key=lambda item: item[0].name if item[0] else ""),
        start=1,
    ):
        material_name = material.name if material else "unassigned"
        merged.append(
            join_group(
                objects,
                f"v5_static_{index:02d}_{slug(material_name)}",
            )
        )
    return merged


def configure_world() -> None:
    scene = bpy.context.scene
    world = scene.world
    if world and world.use_nodes:
        background = next((node for node in world.node_tree.nodes if node.type == "BACKGROUND"), None)
        if background:
            set_input_value(background, ("Strength",), 0.48)
        mapping = next((node for node in world.node_tree.nodes if node.type == "MAPPING"), None)
        if mapping:
            rotation = find_input(mapping, "Rotation")
            if rotation is not None:
                rotation.default_value[2] = math.radians(32)

    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH"):
        try:
            scene.render.engine = engine
            break
        except Exception:
            continue
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1050
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.filepath = str(OUTPUT_PREVIEW)
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass


def world_bounds(root: bpy.types.Object) -> tuple[Vector, Vector]:
    points: list[Vector] = []
    for obj in descendants(root):
        if obj.type != "MESH":
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        return Vector((-1, -1, -1)), Vector((1, 1, 1))
    return (
        Vector((min(v.x for v in points), min(v.y for v in points), min(v.z for v in points))),
        Vector((max(v.x for v in points), max(v.y for v in points), max(v.z for v in points))),
    )


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def render_preview(root: bpy.types.Object) -> None:
    scene = bpy.context.scene
    camera = bpy.data.objects.get("photo_models_preview_camera") or scene.camera
    if camera is None:
        bpy.ops.object.camera_add()
        camera = bpy.context.object
        scene.camera = camera

    visible = recursive_set(root)
    floor = bpy.data.objects.get("photo_v4_factory_floor")
    previous_visibility = {obj: obj.hide_render for obj in scene.objects}
    old_location = root.location.copy()
    root.location = (0, 0, 0)
    for obj in scene.objects:
        if obj.type in {"LIGHT", "CAMERA"}:
            obj.hide_render = False
        elif obj in visible or obj == floor:
            obj.hide_render = False
        else:
            obj.hide_render = True
    bpy.context.view_layer.update()

    mins, maxs = world_bounds(root)
    center = (mins + maxs) * 0.5
    size = max((maxs - mins).x, (maxs - mins).y, (maxs - mins).z, 1.0)
    camera.location = center + Vector((size * 1.16, -size * 1.45, size * 0.84))
    look_at(camera, center + Vector((0, 0, size * 0.04)))
    camera.data.lens = 43
    scene.camera = camera
    scene.render.filepath = str(OUTPUT_PREVIEW)
    bpy.ops.render.render(write_still=True)

    root.location = old_location
    for obj, hidden in previous_visibility.items():
        if obj.name in bpy.data.objects:
            obj.hide_render = hidden
    bpy.context.view_layer.update()


def export_glb(root: bpy.types.Object) -> None:
    old_location = root.location.copy()
    root.location = (0, 0, 0)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for obj in descendants(root):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    kwargs = {
        "filepath": str(OUTPUT_GLB),
        "export_format": "GLB",
        "use_selection": True,
        "export_apply": True,
        "export_yup": True,
        "export_materials": "EXPORT",
    }
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        kwargs.pop("export_yup", None)
        bpy.ops.export_scene.gltf(**kwargs)
    finally:
        root.location = old_location
        bpy.context.view_layer.update()


def triangle_count(root: bpy.types.Object) -> int:
    total = 0
    for obj in descendants(root):
        if obj.type != "MESH":
            continue
        obj.data.calc_loop_triangles()
        total += len(obj.data.loop_triangles)
    return total


def build() -> dict:
    root = bpy.data.objects.get(TARGET_ROOT_NAME)
    if root is not None:
        # Resume safely after an export/render failure without reapplying 500+
        # modifiers or attempting to merge the already-merged geometry again.
        persisted_assets = persist_polyhaven_assets()
        merged = [obj for obj in descendants(root) if obj.name.startswith("v5_static_")]
    else:
        root = bpy.data.objects.get(SOURCE_ROOT_NAME)
        if root is None:
            raise RuntimeError(f"Missing source root: {SOURCE_ROOT_NAME}")

        persisted_assets = persist_polyhaven_assets()
        materials = duplicate_root_materials(root)
        tune_materials(materials)
        apply_modifiers(root)
        build_front_door_assembly(root)
        merged = merge_static_by_material(root)

        root.name = TARGET_ROOT_NAME
        root["model_id"] = "photo_multipurpose_furnace_v5"
        root["model_label"] = "实拍修正高质感箱式气氛多用炉 V5"
        root["detail_level"] = "v5_pbr_hybrid_instancing"
        root["quality_pipeline_version"] = 1
        root["animated_targets"] = json.dumps(ANIMATED_TARGETS, ensure_ascii=False)
        root["static_material_groups"] = len(merged)

    configure_world()
    fix_legacy_front_door_parenting(root)
    export_glb(root)
    render_preview(root)
    bpy.ops.wm.save_as_mainfile(filepath=str(WORKING_BLEND))

    mesh_objects = [obj for obj in descendants(root) if obj.type == "MESH"]
    materials_used = {
        slot.material.name
        for obj in mesh_objects
        for slot in obj.material_slots
        if slot.material
    }
    report = {
        "model_id": root["model_id"],
        "source_model_id": "photo_multipurpose_furnace_v4",
        "triangles": triangle_count(root),
        "mesh_objects": len(mesh_objects),
        "static_material_groups": len(merged),
        "animated_targets": list(ANIMATED_TARGETS),
        "animated_meshes": sum(
            1
            for name in ANIMATED_TARGETS
            for obj in recursive_set(bpy.data.objects[name])
            if obj.type == "MESH"
        ),
        "materials": len(materials_used),
        "glb": workspace_relative(OUTPUT_GLB),
        "glb_bytes": OUTPUT_GLB.stat().st_size,
        "preview": workspace_relative(OUTPUT_PREVIEW),
        "working_blend": workspace_relative(WORKING_BLEND),
        "polyhaven_assets": persisted_assets,
    }
    OUTPUT_REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("PHOTO_MULTIPURPOSE_FURNACE_V5=" + json.dumps(report, ensure_ascii=False))
    return report


if __name__ == "__main__":
    build()
