import math
import os
from pathlib import Path

import bpy
from mathutils import Vector


OUTPUT_DIR = Path(os.environ.get("CODEX_PHOTO_MODEL_OUT", r"C:\Users\27323\AppData\Local\Temp\codex_photo_equipment_models"))
SCENE_NAME = "photo_reference_equipment_models"


def ensure_output_dir():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def remove_generated_scene():
    generated_prefixes = (
        "photo_",
        "multi_",
        "temper_",
        "wash_",
        "cart_",
    )
    for obj in list(bpy.data.objects):
        if obj.get("digital_twin_model") == "photo_reference_equipment" or obj.name.startswith(generated_prefixes):
            bpy.data.objects.remove(obj, do_unlink=True)
    old = bpy.data.scenes.get(SCENE_NAME)
    if old:
        for obj in list(old.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(old)


def new_scene():
    remove_generated_scene()
    scene = bpy.data.scenes.new(SCENE_NAME)
    if bpy.context.window:
        bpy.context.window.scene = scene
    return scene


def mat(name, color, roughness=0.55, metallic=0.0, alpha=1.0):
    existing = bpy.data.materials.get(name)
    material = existing or bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    if bsdf:
        if len(bsdf.inputs) > 0:
            bsdf.inputs[0].default_value = color
        for socket in bsdf.inputs:
            key = (socket.identifier or socket.name or "").lower()
            if "roughness" in key:
                socket.default_value = roughness
            elif "metallic" in key:
                socket.default_value = metallic
            elif "alpha" in key:
                socket.default_value = alpha
    material.diffuse_color = color
    if alpha < 1:
        material.blend_method = "BLEND"
        material.use_screen_refraction = True
    return material


def make_materials():
    return {
        "paint_white": mat("photo_paint_white", (0.86, 0.88, 0.84, 1)),
        "panel_white": mat("photo_panel_warm_white", (0.93, 0.92, 0.86, 1)),
        "light_gray": mat("photo_light_gray", (0.62, 0.65, 0.62, 1)),
        "dark_gray": mat("photo_dark_gray", (0.18, 0.19, 0.18, 1)),
        "black": mat("photo_black_heat_zone", (0.015, 0.014, 0.013, 1)),
        "steel": mat("photo_brushed_steel", (0.64, 0.67, 0.66, 1), roughness=0.35, metallic=0.75),
        "rail_yellow": mat("photo_safety_yellow", (1.0, 0.58, 0.02, 1), roughness=0.45),
        "pipe_green": mat("photo_pipe_green", (0.02, 0.42, 0.12, 1), roughness=0.35),
        "pipe_yellow": mat("photo_gas_pipe_yellow", (0.95, 0.54, 0.0, 1), roughness=0.35),
        "pipe_blue": mat("photo_water_air_blue", (0.1, 0.62, 0.76, 1), roughness=0.35),
        "motor_blue": mat("photo_motor_blue", (0.05, 0.18, 0.52, 1), roughness=0.45, metallic=0.1),
        "motor_green": mat("photo_motor_green_gray", (0.28, 0.42, 0.38, 1), roughness=0.5),
        "red": mat("photo_signal_red", (1.0, 0.08, 0.04, 1), roughness=0.35),
        "green_lamp": mat("photo_signal_green", (0.0, 0.85, 0.25, 1), roughness=0.3),
        "screen": mat("photo_hmi_screen", (0.02, 0.19, 0.26, 1), roughness=0.18),
        "glass": mat("photo_glass_tint", (0.2, 0.45, 0.55, 0.38), roughness=0.1, alpha=0.38),
        "warning": mat("photo_warning_label", (1.0, 0.86, 0.08, 1), roughness=0.4),
        "orange": mat("photo_orange_cap", (1.0, 0.26, 0.08, 1), roughness=0.4),
    }


def set_binding(obj, role, point_hint=""):
    obj["binding_role"] = role
    obj["point_hint"] = point_hint
    obj["digital_twin_model"] = "photo_reference_equipment"
    return obj


def cube(name, loc, scale, material, parent=None, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if material:
        obj.data.materials.append(material)
    if bevel:
        mod = obj.modifiers.new(name="softened_edges", type="BEVEL")
        mod.width = bevel
        mod.segments = 2
        obj.modifiers.new(name="weighted_normals", type="WEIGHTED_NORMAL")
    if parent:
        obj.parent = parent
    return obj


def cyl(name, loc, radius, depth, material, parent=None, vertices=24, axis="z", bevel=False):
    rotation = (0, 0, 0)
    if axis == "x":
        rotation = (0, math.radians(90), 0)
    elif axis == "y":
        rotation = (math.radians(90), 0, 0)
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    if material:
        obj.data.materials.append(material)
    if bevel:
        obj.modifiers.new(name="weighted_normals", type="WEIGHTED_NORMAL")
    if parent:
        obj.parent = parent
    return obj


def cyl_between(name, start, end, radius, material, parent=None, vertices=16):
    start_v = Vector(start)
    end_v = Vector(end)
    mid = (start_v + end_v) * 0.5
    direction = end_v - start_v
    length = direction.length
    if length <= 0:
        return None
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=length, location=mid)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    if material:
        obj.data.materials.append(material)
    obj.modifiers.new(name="weighted_normals", type="WEIGHTED_NORMAL")
    if parent:
        obj.parent = parent
    return obj


def sphere(name, loc, radius, material, parent=None, segments=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=8, radius=radius, location=loc)
    obj = bpy.context.object
    obj.name = name
    if material:
        obj.data.materials.append(material)
    if parent:
        obj.parent = parent
    return obj


def text_mesh(name, text, loc, rot, size, material, parent=None, align="CENTER"):
    bpy.ops.object.text_add(location=loc, rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.data.body = text
    obj.data.align_x = align
    obj.data.align_y = "CENTER"
    obj.data.size = size
    obj.data.extrude = size * 0.035
    if material:
        obj.data.materials.append(material)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    obj.name = name
    if parent:
        obj.parent = parent
    return obj


def make_empty(name, location=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 0.5
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    obj["digital_twin_model"] = "photo_reference_equipment"
    return obj


def make_platform(root, mats, x0, x1, y, z, width=0.78, name="platform"):
    cube(f"{name}_deck", ((x0 + x1) / 2, y, z), (x1 - x0, width, 0.12), mats["rail_yellow"], root, 0.015)
    for x in [x0, (x0 + x1) / 2, x1]:
        for yy in [y - width / 2, y + width / 2]:
            cyl(f"{name}_post_{x:.1f}_{yy:.1f}", (x, yy, z + 0.48), 0.025, 0.96, mats["rail_yellow"], root, 12)
    for yy in [y - width / 2, y + width / 2]:
        cyl_between(f"{name}_top_rail_{yy:.1f}", (x0, yy, z + 0.95), (x1, yy, z + 0.95), 0.025, mats["rail_yellow"], root, 12)
        cyl_between(f"{name}_mid_rail_{yy:.1f}", (x0, yy, z + 0.58), (x1, yy, z + 0.58), 0.018, mats["rail_yellow"], root, 12)


def make_ladder(root, mats, x, y, z0, z1, height_name):
    cyl_between(f"{height_name}_ladder_left", (x, y - 0.25, z0), (x, y - 0.25, z1), 0.018, mats["rail_yellow"], root, 12)
    cyl_between(f"{height_name}_ladder_right", (x, y + 0.25, z0), (x, y + 0.25, z1), 0.018, mats["rail_yellow"], root, 12)
    steps = 7
    for i in range(steps):
        z = z0 + (z1 - z0) * i / (steps - 1)
        cyl_between(f"{height_name}_ladder_step_{i+1:02d}", (x, y - 0.25, z), (x, y + 0.25, z), 0.016, mats["rail_yellow"], root, 12)


def make_motor(name, loc, mats, parent, axis="x", scale=1.0, color_key="motor_green"):
    body = cyl(f"{name}_motor_body", loc, 0.18 * scale, 0.44 * scale, mats[color_key], parent, 20, axis, True)
    set_binding(body, "motor", f"{name}_speed")
    if axis == "x":
        cyl(f"{name}_shaft", (loc[0] + 0.28 * scale, loc[1], loc[2]), 0.045 * scale, 0.22 * scale, mats["steel"], parent, 16, "x")
        cube(f"{name}_gearbox", (loc[0] - 0.28 * scale, loc[1], loc[2]), (0.22 * scale, 0.28 * scale, 0.28 * scale), mats[color_key], parent, 0.025)
    elif axis == "y":
        cyl(f"{name}_shaft", (loc[0], loc[1] + 0.28 * scale, loc[2]), 0.045 * scale, 0.22 * scale, mats["steel"], parent, 16, "y")
        cube(f"{name}_gearbox", (loc[0], loc[1] - 0.28 * scale, loc[2]), (0.28 * scale, 0.22 * scale, 0.28 * scale), mats[color_key], parent, 0.025)
    else:
        cyl(f"{name}_shaft", (loc[0], loc[1], loc[2] + 0.28 * scale), 0.045 * scale, 0.22 * scale, mats["steel"], parent, 16, "z")
        cube(f"{name}_gearbox", (loc[0], loc[1], loc[2] - 0.28 * scale), (0.28 * scale, 0.28 * scale, 0.22 * scale), mats[color_key], parent, 0.025)
    return body


def make_gauge(name, loc, mats, parent, rotation=(math.radians(90), 0, 0)):
    face = cyl(name, loc, 0.095, 0.025, mats["panel_white"], parent, 24, "y")
    ring = cyl(f"{name}_steel_ring", (loc[0], loc[1] - 0.018, loc[2]), 0.102, 0.018, mats["steel"], parent, 24, "y")
    needle = cube(f"{name}_needle", (loc[0], loc[1] - 0.036, loc[2]), (0.012, 0.006, 0.12), mats["red"], parent, 0.002)
    needle.rotation_euler[1] = math.radians(25)
    return face


def make_valve(name, loc, mats, parent, pipe_key="pipe_yellow"):
    cyl(f"{name}_pipe_stub", loc, 0.035, 0.38, mats[pipe_key], parent, 14, "x")
    body = cube(f"{name}_valve_body", loc, (0.13, 0.13, 0.13), mats["steel"], parent, 0.02)
    handle = cyl(f"{name}_handle", (loc[0], loc[1], loc[2] + 0.13), 0.015, 0.22, mats["red"], parent, 10, "x")
    set_binding(body, "valve", f"{name}_open")
    set_binding(handle, "valve_handle", f"{name}_open")
    return body


def build_multipurpose_furnace(mats):
    root = make_empty("photo_multipurpose_furnace_root")
    set_binding(root, "device_root", "multipurpose_furnace")

    cube("multi_base_skid", (0, 0, 0.12), (4.8, 1.72, 0.24), mats["dark_gray"], root, 0.03)
    cube("multi_main_rear_chamber", (0.7, 0, 1.18), (2.85, 1.55, 1.88), mats["paint_white"], root, 0.055)
    cube("multi_front_service_bay", (-1.25, 0, 0.94), (1.2, 1.42, 1.42), mats["paint_white"], root, 0.04)
    cube("multi_lower_oil_tank", (0.0, 0.0, 0.42), (3.85, 1.48, 0.42), mats["light_gray"], root, 0.035)

    cube("multi_black_furnace_mouth_frame", (2.15, -0.03, 1.2), (0.38, 1.72, 1.76), mats["black"], root, 0.025)
    front_door = cube("multi_front_heat_door_black_panel", (2.38, -0.03, 1.03), (0.12, 1.12, 1.18), mats["black"], root, 0.025)
    set_binding(front_door, "front_door", "doors.front_door_open")
    cube("multi_hearth_glow_window", (2.45, -0.03, 1.12), (0.035, 0.86, 0.8), mats["glass"], root, 0.01)
    middle = cube("multi_middle_door_reference", (0.82, -0.82, 1.1), (1.0, 0.08, 1.12), mats["dark_gray"], root, 0.02)
    set_binding(middle, "middle_door", "doors.middle_door_open")

    cube("multi_large_black_exhaust_hood", (2.05, 0, 2.28), (1.25, 1.86, 0.82), mats["black"], root, 0.04)
    cube("multi_sloped_hood_left_plate", (1.48, 0, 2.58), (0.18, 1.86, 0.95), mats["light_gray"], root, 0.03).rotation_euler[1] = math.radians(-18)
    cube("multi_sloped_hood_right_plate", (2.55, 0, 2.58), (0.18, 1.86, 0.95), mats["light_gray"], root, 0.03).rotation_euler[1] = math.radians(18)
    cyl("multi_top_exhaust_stack", (2.08, 0, 3.08), 0.18, 0.78, mats["black"], root, 24, "z")
    cyl("multi_top_stack_flange", (2.08, 0, 2.72), 0.26, 0.05, mats["black"], root, 24, "z")

    cabinet = cube("multi_control_cabinet_with_hmi", (-2.25, -0.92, 1.03), (0.72, 0.22, 1.82), mats["panel_white"], root, 0.03)
    set_binding(cabinet, "control_cabinet", "status.control_power")
    cube("multi_hmi_screen", (-2.25, -1.04, 1.42), (0.42, 0.035, 0.28), mats["screen"], root, 0.01)
    for i, x in enumerate([-2.45, -2.25, -2.05]):
        sphere(f"multi_panel_button_{i+1}", (x, -1.065, 1.08), 0.035, mats["dark_gray"], root, 12)
        sphere(f"multi_panel_lamp_{i+1}", (x, -1.065, 0.92), 0.027, mats["red" if i == 1 else "green_lamp"], root, 12)

    make_platform(root, mats, -2.1, -0.75, 0.82, 2.22, 0.64, "multi_yellow_upper_platform")
    make_ladder(root, mats, -2.22, 0.78, 0.35, 2.35, "multi_yellow_access_ladder")

    for i, z in enumerate([1.15, 1.68, 2.08]):
        make_motor(f"multi_side_gear_motor_{i+1:02d}", (-0.4 + i * 0.68, -0.92, z), mats, root, axis="y", scale=0.82, color_key="motor_green")
    make_motor("multi_oil_stir_motor", (-0.88, -0.86, 0.62), mats, root, axis="z", scale=0.92, color_key="motor_blue")
    set_binding(bpy.data.objects["multi_oil_stir_motor_motor_body"], "oil_stirrer", "motors.oil_stir_1_speed")

    cyl_between("multi_yellow_gas_header", (-1.8, -0.96, 0.58), (1.65, -0.96, 0.58), 0.035, mats["pipe_yellow"], root)
    cyl_between("multi_blue_air_header", (-1.9, -0.98, 0.38), (0.8, -0.98, 0.38), 0.03, mats["pipe_blue"], root)
    for i, x in enumerate([-1.55, -1.15, -0.75, -0.35, 0.05, 0.45, 0.85, 1.25]):
        make_valve(f"multi_gas_valve_{i+1:02d}", (x, -0.98, 0.78), mats, root, "pipe_yellow")
        cyl_between(f"multi_gas_drop_{i+1:02d}", (x, -0.96, 0.58), (x, -0.96, 0.96), 0.022, mats["pipe_yellow"], root)
    make_gauge("multi_pressure_gauge_01", (-0.42, -1.02, 0.83), mats, root)
    make_gauge("multi_pressure_gauge_02", (0.12, -1.02, 0.83), mats, root)

    cyl_between("multi_front_rail_left", (-2.35, 0.72, 0.22), (2.35, 0.72, 0.22), 0.035, mats["steel"], root)
    cyl_between("multi_front_rail_right", (-2.35, 1.02, 0.22), (2.35, 1.02, 0.22), 0.035, mats["steel"], root)
    text_mesh("multi_small_red_brand_plate", "K", (2.2, -0.96, 2.55), (math.radians(90), 0, 0), 0.28, mats["red"], root)
    return root


def build_tempering_furnace(mats):
    root = make_empty("photo_tempering_furnace_root")
    set_binding(root, "device_root", "tempering_furnace")

    cube("temper_base_frame", (0, 0, 0.13), (3.05, 1.58, 0.26), mats["dark_gray"], root, 0.03)
    cube("temper_tall_body_shell", (0, 0, 1.3), (2.45, 1.36, 2.18), mats["paint_white"], root, 0.055)
    door = cube("temper_large_lift_door_black", (-1.28, -0.02, 1.25), (0.16, 1.04, 1.42), mats["black"], root, 0.03)
    set_binding(door, "lift_door", "doors.tempering_door_open")
    cube("temper_front_black_column_left", (-1.36, -0.64, 1.32), (0.22, 0.14, 1.95), mats["black"], root, 0.02)
    cube("temper_front_black_column_right", (-1.36, 0.64, 1.32), (0.22, 0.14, 1.95), mats["black"], root, 0.02)
    cyl_between("temper_door_lift_shaft", (-1.48, -0.67, 2.17), (-1.48, 0.67, 2.17), 0.035, mats["steel"], root)
    for y in [-0.55, 0.55]:
        cyl_between(f"temper_vertical_lift_screw_{y}", (-1.45, y, 0.46), (-1.45, y, 2.15), 0.035, mats["steel"], root)

    cube("temper_smoke_hood_box", (-0.52, 0, 2.55), (1.85, 1.68, 0.78), mats["dark_gray"], root, 0.045)
    cube("temper_hood_sloped_front", (-1.15, 0, 2.48), (0.18, 1.68, 0.85), mats["dark_gray"], root, 0.025).rotation_euler[1] = math.radians(-18)
    cube("temper_hood_sloped_rear", (0.28, 0, 2.48), (0.18, 1.68, 0.85), mats["light_gray"], root, 0.025).rotation_euler[1] = math.radians(18)
    cyl("temper_top_exhaust_stack", (-0.45, 0, 3.15), 0.17, 0.55, mats["black"], root, 24, "z")
    text_mesh("temper_red_brand_plate", "K", (-1.15, -0.88, 2.55), (math.radians(90), 0, 0), 0.24, mats["red"], root)

    make_platform(root, mats, 0.55, 1.52, 0.95, 2.05, 0.78, "temper_side_platform")
    make_ladder(root, mats, 1.55, 0.88, 0.22, 2.15, "temper_ladder")
    for x in [-0.35, 0.35, 0.95]:
        cube(f"temper_side_reinforcement_rib_{x:.1f}", (x, 0.72, 1.16), (0.08, 0.08, 1.55), mats["light_gray"], root, 0.015)
    make_motor("temper_door_drive_motor", (-1.34, -0.86, 1.98), mats, root, axis="y", scale=0.75, color_key="motor_green")
    cyl("temper_yellow_blower_side", (0.52, -0.86, 1.62), 0.28, 0.36, mats["rail_yellow"], root, 24, "y")
    set_binding(bpy.data.objects["temper_yellow_blower_side"], "blower", "motors.tempering_fan_speed")
    for i, z in enumerate([0.86, 1.06, 1.26]):
        sphere(f"temper_stack_light_{i+1}", (-1.45, -0.84, z), 0.045, mats[["green_lamp", "rail_yellow", "red"][i]], root, 12)
    return root


def build_washing_machine(mats):
    root = make_empty("photo_washing_machine_root")
    set_binding(root, "device_root", "washing_machine")

    cube("wash_base_frame", (0, 0, 0.13), (3.95, 1.55, 0.26), mats["dark_gray"], root, 0.03)
    cube("wash_lower_tank", (0.34, 0, 0.73), (2.95, 1.38, 0.9), mats["paint_white"], root, 0.05)
    cube("wash_upper_process_tank", (0.65, 0, 1.62), (2.42, 1.22, 1.0), mats["panel_white"], root, 0.05)
    cube("wash_top_lid_orange_left", (0.0, -0.38, 2.18), (0.62, 0.22, 0.12), mats["orange"], root, 0.02)
    cube("wash_top_lid_orange_right", (0.88, 0.38, 2.18), (0.62, 0.22, 0.12), mats["orange"], root, 0.02)
    cube("wash_control_cabinet", (-1.85, -0.83, 1.08), (0.62, 0.22, 1.5), mats["panel_white"], root, 0.03)
    cube("wash_hmi_screen", (-1.85, -0.955, 1.32), (0.3, 0.035, 0.2), mats["screen"], root, 0.01)
    sphere("wash_stack_light_red", (-1.85, -0.94, 1.95), 0.05, mats["red"], root, 12)
    sphere("wash_stack_light_green", (-1.85, -0.94, 2.05), 0.05, mats["green_lamp"], root, 12)

    for i, x in enumerate([-1.1, -0.28, 0.55, 1.34]):
        make_motor(f"wash_blue_pump_{i+1:02d}", (x, -0.98, 0.34), mats, root, axis="x", scale=0.72, color_key="motor_blue")
        set_binding(bpy.data.objects[f"wash_blue_pump_{i+1:02d}_motor_body"], "pump", f"motors.wash_pump_{i+1}_speed")

    pipe_pts = [
        ((-1.3, -1.02, 0.56), (1.55, -1.02, 0.56), "wash_green_lower_header"),
        ((-0.85, -1.02, 0.56), (-0.85, -1.02, 1.62), "wash_green_vertical_01"),
        ((-0.05, -1.02, 0.56), (-0.05, -1.02, 1.78), "wash_green_vertical_02"),
        ((0.75, -1.02, 0.56), (0.75, -1.02, 1.48), "wash_green_vertical_03"),
        ((1.45, -1.02, 0.56), (1.45, -1.02, 1.22), "wash_green_vertical_04"),
        ((-0.85, -1.02, 1.62), (1.24, -1.02, 1.62), "wash_green_mid_header"),
        ((-0.05, -1.02, 1.9), (0.95, -1.02, 1.9), "wash_green_top_header"),
    ]
    for start, end, name in pipe_pts:
        cyl_between(name, start, end, 0.045, mats["pipe_green"], root, 16)
    for i, x in enumerate([-0.75, -0.18, 0.42, 1.05, 1.48]):
        make_valve(f"wash_green_valve_{i+1:02d}", (x, -1.02, 0.86 + (i % 2) * 0.38), mats, root, "pipe_green")
    for i, x in enumerate([-0.6, 0.2, 1.0]):
        cyl(f"wash_filter_canister_{i+1}", (x, -0.91, 1.18), 0.13, 0.42, mats["panel_white"], root, 24, "z")
    make_platform(root, mats, -1.28, 1.5, 0.83, 2.35, 0.58, "wash_upper_service_platform")
    make_ladder(root, mats, -1.48, 0.82, 0.25, 2.45, "wash_ladder")
    return root


def build_transfer_cart(mats):
    root = make_empty("photo_transfer_cart_root")
    set_binding(root, "device_root", "transfer_cart")

    cube("cart_black_base_frame", (0, 0, 0.18), (2.45, 1.45, 0.28), mats["black"], root, 0.025)
    cube("cart_light_front_panel", (-0.72, -0.58, 0.72), (0.84, 0.12, 0.82), mats["panel_white"], root, 0.025)
    cube("cart_roller_bed_frame", (0.36, 0, 0.74), (1.72, 1.05, 0.16), mats["dark_gray"], root, 0.02)
    for i, x in enumerate([-0.35, -0.05, 0.25, 0.55, 0.85]):
        roller = cyl(f"cart_live_roller_{i+1:02d}", (x, 0, 0.84), 0.045, 1.0, mats["steel"], root, 16, "y")
        set_binding(roller, "roller", "motors.cart_roller_speed")
    make_motor("cart_side_drive_motor", (1.36, 0.55, 0.62), mats, root, axis="y", scale=0.65, color_key="motor_green")
    make_motor("cart_lower_drive_motor", (0.72, 0.68, 0.23), mats, root, axis="x", scale=0.52, color_key="motor_green")

    for x in [-1.05, -0.25, 0.55, 1.15]:
        for y in [-0.72, 0.72]:
            cyl(f"cart_wheel_{x:.1f}_{y:.1f}", (x, y, 0.02), 0.12, 0.08, mats["dark_gray"], root, 20, "y")
    for y in [-0.78, 0.78]:
        cyl_between(f"cart_track_reference_{y:.1f}", (-1.45, y, -0.05), (1.45, y, -0.05), 0.032, mats["steel"], root, 16)

    # Yellow handrail around the cart, matching the photos.
    for x in [-1.18, -0.48, 0.32, 1.18]:
        for y in [-0.8, 0.8]:
            cyl(f"cart_yellow_guard_post_{x:.1f}_{y:.1f}", (x, y, 0.82), 0.025, 1.12, mats["rail_yellow"], root, 12)
    for y in [-0.8, 0.8]:
        cyl_between(f"cart_yellow_top_guard_{y:.1f}", (-1.18, y, 1.38), (1.18, y, 1.38), 0.028, mats["rail_yellow"], root, 12)
        cyl_between(f"cart_yellow_mid_guard_{y:.1f}", (-1.18, y, 1.02), (1.18, y, 1.02), 0.02, mats["rail_yellow"], root, 12)
    cyl_between("cart_yellow_front_guard_top", (-1.18, -0.8, 1.38), (-1.18, 0.8, 1.38), 0.028, mats["rail_yellow"], root, 12)
    cyl_between("cart_yellow_rear_guard_top", (1.18, -0.8, 1.38), (1.18, 0.8, 1.38), 0.028, mats["rail_yellow"], root, 12)
    sphere("cart_warning_beacon", (0.0, -0.78, 1.52), 0.08, mats["orange"], root, 16)
    return root


def all_children(root):
    result = [root]
    stack = list(root.children)
    while stack:
        obj = stack.pop()
        result.append(obj)
        stack.extend(obj.children)
    return result


def world_bounds(root):
    coords = []
    for obj in all_children(root):
        if obj.type == "MESH":
            for corner in obj.bound_box:
                coords.append(obj.matrix_world @ Vector(corner))
    if not coords:
        return Vector((-1, -1, -1)), Vector((1, 1, 1))
    mins = Vector((min(v.x for v in coords), min(v.y for v in coords), min(v.z for v in coords)))
    maxs = Vector((max(v.x for v in coords), max(v.y for v in coords), max(v.z for v in coords)))
    return mins, maxs


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_lighting(scene):
    world = scene.world or bpy.data.worlds.new("photo_equipment_world")
    scene.world = world
    world.color = (0.035, 0.04, 0.045)
    bpy.ops.object.light_add(type="AREA", location=(0, -4.2, 6.2))
    key = bpy.context.object
    key.name = "photo_models_large_softbox"
    key.data.energy = 650
    key.data.size = 5.0
    bpy.ops.object.light_add(type="POINT", location=(-3.5, 2.8, 3.5))
    fill = bpy.context.object
    fill.name = "photo_models_warm_fill"
    fill.data.energy = 95
    bpy.ops.object.camera_add(location=(5.8, -6.2, 3.6))
    cam = bpy.context.object
    cam.name = "photo_models_preview_camera"
    cam.data.lens = 38
    scene.camera = cam
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        try:
            scene.render.engine = "BLENDER_EEVEE"
        except Exception:
            scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 840
    scene.render.film_transparent = False
    return cam


def select_root(root):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in all_children(root):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root


def export_glb(root, file_path):
    old_location = root.location.copy()
    root.location = (0, 0, 0)
    bpy.context.view_layer.update()
    select_root(root)
    try:
        bpy.ops.export_scene.gltf(
            filepath=str(file_path),
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_yup=True,
        )
    except TypeError:
        bpy.ops.export_scene.gltf(
            filepath=str(file_path),
            export_format="GLB",
            use_selection=True,
            export_apply=True,
        )
    root.location = old_location
    bpy.context.view_layer.update()


def render_preview(scene, cam, roots, root, file_path):
    old_locations = {item.name: item.location.copy() for item in roots}
    for item in roots:
        item.location = (0, 0, 0) if item == root else item.location
        for obj in all_children(item):
            obj.hide_render = item != root
            obj.hide_viewport = item != root
    bpy.context.view_layer.update()
    mins, maxs = world_bounds(root)
    center = (mins + maxs) * 0.5
    size = max((maxs - mins).x, (maxs - mins).y, (maxs - mins).z, 1.0)
    cam.location = center + Vector((size * 1.15, -size * 1.45, size * 0.88))
    look_at(cam, center + Vector((0, 0, size * 0.06)))
    cam.data.lens = 42
    scene.render.filepath = str(file_path)
    bpy.ops.render.render(write_still=True)
    for item in roots:
        item.location = old_locations[item.name]
        for obj in all_children(item):
            obj.hide_render = False
            obj.hide_viewport = False
    bpy.context.view_layer.update()


def render_overview(scene, cam, roots, file_path):
    for root in roots:
        for obj in all_children(root):
            obj.hide_render = False
            obj.hide_viewport = False
    cam.location = (7.2, -7.8, 4.7)
    look_at(cam, (0.3, 0, 1.25))
    cam.data.lens = 32
    scene.render.filepath = str(file_path)
    bpy.ops.render.render(write_still=True)


def count_meshes(root):
    return sum(1 for obj in all_children(root) if obj.type == "MESH")


def main():
    ensure_output_dir()
    scene = new_scene()
    mats = make_materials()
    cam = setup_lighting(scene)
    cube("photo_models_factory_floor", (0, 0, -0.08), (9.5, 4.2, 0.08), mats["dark_gray"], None, 0)

    specs = [
        ("photo_multipurpose_furnace", "Photo Multipurpose Furnace", build_multipurpose_furnace),
        ("photo_tempering_furnace", "Photo Tempering Furnace", build_tempering_furnace),
        ("photo_washing_machine", "Photo Washing Machine", build_washing_machine),
        ("photo_transfer_cart", "Photo Transfer Cart", build_transfer_cart),
    ]
    roots = []
    for model_id, label, builder in specs:
        root = builder(mats)
        root["model_id"] = model_id
        root["model_label"] = label
        roots.append(root)

    preview_locations = {
        "photo_multipurpose_furnace_root": (-2.5, -0.75, 0),
        "photo_tempering_furnace_root": (2.1, -0.75, 0),
        "photo_washing_machine_root": (-2.25, 1.35, 0),
        "photo_transfer_cart_root": (2.15, 1.35, 0),
    }
    for root in roots:
        root.location = preview_locations[root.name]

    outputs = {}
    for model_id, label, _builder in specs:
        root = next(item for item in roots if item["model_id"] == model_id)
        glb_path = OUTPUT_DIR / f"{model_id}.glb"
        preview_path = OUTPUT_DIR / f"{model_id}_preview.png"
        export_glb(root, glb_path)
        render_preview(scene, cam, roots, root, preview_path)
        outputs[model_id] = {
            "glb": str(glb_path),
            "preview": str(preview_path),
            "mesh_count": count_meshes(root),
            "object_count": len(all_children(root)),
        }

    overview_path = OUTPUT_DIR / "photo_equipment_models_overview.png"
    render_overview(scene, cam, roots, overview_path)
    blend_path = OUTPUT_DIR / "photo_equipment_models.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    outputs["_overview"] = str(overview_path)
    outputs["_blend"] = str(blend_path)
    print("PHOTO_EQUIPMENT_MODEL_OUTPUTS=" + repr(outputs))
    return outputs


if __name__ == "__main__":
    main()
