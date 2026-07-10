import importlib.util
import math
import os
from pathlib import Path

import bpy
from mathutils import Vector


SCRIPT_DIR = Path(os.environ.get("CODEX_PHOTO_MODEL_SCRIPT_DIR", r"C:\Users\27323\AppData\Local\Temp\codex_photo_equipment_models_v4"))
OUTPUT_DIR = Path(os.environ.get("CODEX_PHOTO_MODEL_V4_OUT", r"C:\Users\27323\AppData\Local\Temp\codex_photo_equipment_models_v4"))

os.environ.setdefault("CODEX_PHOTO_MODEL_BASE_SCRIPT", str(SCRIPT_DIR / "blender_generate_photo_equipment_models.py"))
os.environ.setdefault("CODEX_PHOTO_MODEL_V2_SCRIPT", str(SCRIPT_DIR / "blender_generate_photo_equipment_models_v2.py"))
V3_SCRIPT = Path(os.environ.get("CODEX_PHOTO_MODEL_V3_SCRIPT", str(SCRIPT_DIR / "blender_generate_photo_equipment_models_v3.py")))


def load_v3_module():
    spec = importlib.util.spec_from_file_location("photo_equipment_v3", V3_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


v3 = load_v3_module()
v2 = v3.v2
base = v3.base


def mat(name, color, roughness=0.5, metallic=0.0, alpha=1.0):
    return base.mat(name, color, roughness, metallic, alpha)


def make_v4_materials():
    mats = v3.make_v3_materials()
    mats.update({
        "sheet_edge": mat("photo_v4_dark_sheet_metal_edge", (0.06, 0.065, 0.06, 1), 0.66),
        "sheet_shadow": mat("photo_v4_panel_shadow_line", (0.018, 0.018, 0.016, 1), 0.74),
        "matte_black": mat("photo_v4_matte_black_frame", (0.008, 0.008, 0.007, 1), 0.82),
        "warm_white": mat("photo_v4_warm_flat_white", (0.88, 0.89, 0.84, 1), 0.62),
        "cabinet_ivory": mat("photo_v4_electrical_cabinet_ivory", (0.91, 0.90, 0.82, 1), 0.58),
        "track_steel": mat("photo_v4_track_dark_steel", (0.30, 0.31, 0.30, 1), 0.42, 0.55),
        "yellow_cover": mat("photo_v4_wash_yellow_round_cover", (0.98, 0.63, 0.03, 1), 0.46),
        "black_oil": mat("photo_v4_blackened_oil_and_heat", (0.012, 0.011, 0.009, 1), 0.72),
        "button_white": mat("photo_v4_white_indicator_button", (0.94, 0.95, 0.92, 1), 0.36),
        "button_blue": mat("photo_v4_blue_indicator_button", (0.08, 0.30, 0.86, 1), 0.3),
        "warning_yellow": mat("photo_v4_warning_yellow_label", (1.0, 0.82, 0.06, 1), 0.42),
    })
    return mats


def cube(name, loc, scale, material, parent=None, bevel=0.0, rot=(0, 0, 0)):
    return v3.cube(name, loc, scale, material, parent, bevel, rot)


def cyl(name, loc, radius, depth, material, parent=None, vertices=20, axis="z"):
    return v3.cyl(name, loc, radius, depth, material, parent, vertices, axis)


def cyl_between(name, start, end, radius, material, parent=None, vertices=14):
    return v3.cyl_between(name, start, end, radius, material, parent, vertices)


def sphere(name, loc, radius, material, parent=None, segments=14):
    return v3.sphere(name, loc, radius, material, parent, segments)


def text(name, body, loc, rot, size, material, parent=None, align="CENTER"):
    return v3.text(name, body, loc, rot, size, material, parent, align)


def binding(obj, role, point_hint=""):
    return base.set_binding(obj, role, point_hint)


def all_children(root):
    return base.all_children(root)


def remove_object_tree(obj):
    for child in list(obj.children):
        remove_object_tree(child)
    bpy.data.objects.remove(obj, do_unlink=True)


def remove_by_name(root, exact=(), prefixes=(), contains=()):
    for obj in list(all_children(root)):
        if obj == root:
            continue
        name = obj.name
        if name in exact or any(name.startswith(prefix) for prefix in prefixes) or any(part in name for part in contains):
            if obj.name in bpy.data.objects:
                remove_object_tree(obj)


def relink_model(root, model_id, label):
    root.name = f"{model_id}_root"
    root["model_id"] = model_id
    root["model_label"] = label
    root["detail_level"] = "v4_photo_corrected_hard_edge"
    for obj in all_children(root):
        binding(obj, obj.get("binding_role", "model_part"), obj.get("point_hint", ""))


def harden_edges(root):
    rounded_whitelist = ("pipe", "rail", "roller", "wheel", "motor_body", "shaft", "gauge", "stack", "cylinder")
    for obj in all_children(root):
        if obj.type != "MESH":
            continue
        name = obj.name.lower()
        for mod in obj.modifiers:
            if mod.type == "BEVEL":
                if any(key in name for key in rounded_whitelist):
                    continue
                max_dim = max(obj.dimensions.x, obj.dimensions.y, obj.dimensions.z)
                if max_dim > 0.55:
                    mod.width = min(mod.width, 0.004)
                    mod.segments = 1
                elif max_dim > 0.2:
                    mod.width = min(mod.width, 0.006)
                    mod.segments = 1
                else:
                    mod.width = min(mod.width, 0.008)
                    mod.segments = 1


def add_front_face_frame(prefix, parent, mats, x, y, z, w, h, orientation="x", thickness=0.035):
    if orientation == "x":
        cube(f"{prefix}_frame_left", (x, y - w / 2, z), (thickness, thickness, h), mats["sheet_edge"], parent, 0.001)
        cube(f"{prefix}_frame_right", (x, y + w / 2, z), (thickness, thickness, h), mats["sheet_edge"], parent, 0.001)
        cube(f"{prefix}_frame_top", (x, y, z + h / 2), (thickness, w + thickness, thickness), mats["sheet_edge"], parent, 0.001)
        cube(f"{prefix}_frame_bottom", (x, y, z - h / 2), (thickness, w + thickness, thickness), mats["sheet_edge"], parent, 0.001)
    else:
        cube(f"{prefix}_frame_left", (x - w / 2, y, z), (thickness, thickness, h), mats["sheet_edge"], parent, 0.001)
        cube(f"{prefix}_frame_right", (x + w / 2, y, z), (thickness, thickness, h), mats["sheet_edge"], parent, 0.001)
        cube(f"{prefix}_frame_top", (x, y, z + h / 2), (w + thickness, thickness, thickness), mats["sheet_edge"], parent, 0.001)
        cube(f"{prefix}_frame_bottom", (x, y, z - h / 2), (w + thickness, thickness, thickness), mats["sheet_edge"], parent, 0.001)


def add_sheet_panel_grid(prefix, parent, mats, y, x0, x1, z0, z1, cols=3, rows=2):
    for i in range(1, cols):
        x = x0 + (x1 - x0) * i / cols
        cube(f"{prefix}_vertical_sheet_joint_{i:02d}", (x, y, (z0 + z1) / 2), (0.018, 0.018, z1 - z0), mats["sheet_shadow"], parent, 0)
    for i in range(1, rows):
        z = z0 + (z1 - z0) * i / rows
        cube(f"{prefix}_horizontal_sheet_joint_{i:02d}", ((x0 + x1) / 2, y, z), (x1 - x0, 0.018, 0.018), mats["sheet_shadow"], parent, 0)


def add_warning_labels(prefix, parent, mats, locs, face_axis="y"):
    for idx, loc in enumerate(locs, start=1):
        panel = cube(f"{prefix}_warning_label_{idx:02d}", loc, (0.12, 0.008, 0.07) if face_axis == "y" else (0.008, 0.12, 0.07), mats["warning_yellow"], parent, 0.001)
        binding(panel, "warning_label", "")
        if face_axis == "y":
            text(f"{prefix}_warning_label_mark_{idx:02d}", "!", (loc[0], loc[1] - 0.006, loc[2]), (math.radians(90), 0, 0), 0.045, mats["caution_black"], parent)


def add_rect_tube_between(prefix, parent, mats, p1, p2, thickness=0.045):
    return cyl_between(prefix, p1, p2, thickness / 2, mats["matte_black"], parent, 8)


def add_operator_buttons(prefix, parent, mats, start, count=8, dx=0.13):
    x0, y, z = start
    colors = ["button_white", "button_white", "button_white", "button_blue", "button_white", "button_white", "green_lamp", "red"]
    for i in range(count):
        key = colors[i % len(colors)]
        sphere(f"{prefix}_push_button_{i+1:02d}", (x0 + i * dx, y, z), 0.035, mats[key], parent, 12)
        cyl(f"{prefix}_button_bezel_{i+1:02d}", (x0 + i * dx, y, z - 0.006), 0.041, 0.01, mats["stainless"], parent, 16, "z")


def refine_multipurpose(root, mats):
    relink_model(root, "photo_multipurpose_furnace_v4", "实拍修正版 箱式气氛多用炉 V4")
    harden_edges(root)
    add_sheet_panel_grid("multi_v4_left_body_panels", root, mats, -0.852, -1.7, 1.45, 0.42, 1.92, 5, 3)
    add_sheet_panel_grid("multi_v4_rear_chamber_panels", root, mats, 0.802, -0.7, 1.95, 0.55, 1.9, 4, 2)
    add_front_face_frame("multi_v4_front_hearth_hard_frame", root, mats, 2.575, 0, 1.12, 1.36, 1.48, "x", 0.035)
    cube("multi_v4_front_flat_black_inner_door", (2.595, 0, 1.12), (0.024, 0.76, 0.74), mats["black_oil"], root, 0.001)
    cube("multi_v4_oil_tank_rect_front", (-0.15, -0.872, 0.44), (3.75, 0.03, 0.38), mats["sheet_edge"], root, 0.001)

    # Four oil agitator drive heads are important process-state points on this furnace.
    for idx, y in enumerate([-0.48, -0.16, 0.16, 0.48], start=1):
        motor = cyl(f"multi_v4_oil_agitator_motor_{idx:02d}", (-1.0 + idx * 0.34, 0.86, 0.78), 0.105, 0.24, mats["motor_blue"], root, 18, "z")
        cyl(f"multi_v4_oil_agitator_shaft_{idx:02d}", (-1.0 + idx * 0.34, 0.86, 0.46), 0.018, 0.52, mats["stainless"], root, 12, "z")
        binding(motor, "oil_stirrer", f"motors.oil_stir_{idx}_speed")

    for idx, x in enumerate([-0.55, 0.65], start=1):
        fan = cyl(f"multi_v4_roof_circulation_fan_{idx:02d}", (x, 0.0, 2.18), 0.16, 0.09, mats["motor_green"], root, 20, "z")
        cyl(f"multi_v4_roof_fan_guard_{idx:02d}", (x, 0.0, 2.29), 0.22, 0.018, mats["stainless"], root, 24, "z")
        binding(fan, "circulation_fan", f"motors.furnace_fan_{idx}_speed")

    for i, x in enumerate([-1.58, -1.18, -0.78, -0.38, 0.02, 0.42, 0.82, 1.22, 1.58], start=1):
        cube(f"multi_v4_valve_square_tag_{i:02d}", (x, -1.068, 0.66), (0.08, 0.012, 0.052), mats["warning_yellow"], root, 0.001)
    add_warning_labels("multi_v4_service", root, mats, [(-2.26, -1.072, 0.52), (-1.55, -0.868, 0.28)], "y")
    return root


def refine_tempering(root, mats):
    relink_model(root, "photo_tempering_furnace_v4", "实拍修正版 回火炉 V4")
    remove_by_name(root, exact=("temper_yellow_blower_side",), contains=("yellow_blower",))
    harden_edges(root)

    # Repair the side where the mistaken round part was mounted.
    cube("temper_v4_plain_side_sheet_after_removed_round_part", (0.52, -0.872, 1.62), (0.72, 0.026, 0.86), mats["warm_white"], root, 0.001)
    add_sheet_panel_grid("temper_v4_side_panel", root, mats, -0.89, -0.1, 1.15, 0.72, 1.96, 3, 3)
    add_front_face_frame("temper_v4_lift_door_hard_frame", root, mats, -1.62, 0, 1.22, 1.32, 1.7, "x", 0.04)
    cube("temper_v4_lift_door_flat_heat_plate", (-1.655, 0, 1.16), (0.026, 0.86, 1.08), mats["black_oil"], root, 0.001)
    cube("temper_v4_hood_sharp_lower_shadow", (-1.02, -0.895, 2.18), (1.34, 0.042, 0.12), mats["sheet_shadow"], root, 0.001)

    for y in [-0.62, 0.62]:
        cyl_between(f"temper_v4_vertical_chain_guide_{y}", (-1.69, y, 0.38), (-1.69, y, 2.12), 0.018, mats["track_steel"], root, 10)
        for i in range(9):
            cube(f"temper_v4_chain_block_{y}_{i:02d}", (-1.71, y, 0.56 + i * 0.17), (0.028, 0.07, 0.024), mats["track_steel"], root, 0.001)

    add_warning_labels("temper_v4_front", root, mats, [(-0.62, -0.888, 0.68), (0.18, -0.888, 0.68)], "y")
    cube("temper_v4_side_motor_mount_plate", (-1.38, -0.88, 1.98), (0.24, 0.035, 0.24), mats["track_steel"], root, 0.001)
    return root


def refine_washing(root, mats):
    relink_model(root, "photo_washing_machine_v4", "实拍修正版 清洗机 V4")
    harden_edges(root)
    add_sheet_panel_grid("wash_v4_large_side_panels", root, mats, -0.738, -0.85, 1.75, 0.46, 2.12, 4, 3)
    add_sheet_panel_grid("wash_v4_cabinet_panels", root, mats, -0.99, -2.12, -1.58, 0.48, 1.78, 1, 3)

    # Correct cleaning-machine loading mouth: black rectangular inlet plus feed rollers.
    add_front_face_frame("wash_v4_feed_mouth_outer_frame", root, mats, 2.16, 0.02, 1.18, 0.92, 0.62, "x", 0.04)
    cube("wash_v4_feed_mouth_dark_opening", (2.19, 0.02, 1.18), (0.03, 0.72, 0.42), mats["dark_inner"], root, 0.001)
    cube("wash_v4_feed_mouth_lower_lip", (2.26, 0.02, 0.88), (0.26, 0.86, 0.06), mats["stainless"], root, 0.002)
    for idx, y in enumerate([-0.34, -0.17, 0.0, 0.17, 0.34], start=1):
        roller = cyl(f"wash_v4_inlet_feed_roller_{idx:02d}", (2.42, y, 0.94), 0.025, 0.34, mats["stainless"], root, 14, "x")
        binding(roller, "inlet_roller", "motors.wash_inlet_roller_speed")
    for y in [-0.42, 0.42]:
        cyl_between(f"wash_v4_inlet_side_rail_{y}", (2.28, y, 0.99), (2.74, y, 0.99), 0.018, mats["stainless"], root, 10)

    # The round cover belongs to the cleaning machine, not the tempering furnace.
    round_cover = cyl("wash_v4_yellow_side_round_cover", (-1.1, -0.785, 1.82), 0.28, 0.08, mats["yellow_cover"], root, 28, "y")
    cyl("wash_v4_round_cover_black_hinge", (-1.1, -0.835, 1.82), 0.028, 0.38, mats["matte_black"], root, 12, "z")
    cube("wash_v4_round_cover_mount_bracket", (-1.1, -0.84, 1.56), (0.36, 0.035, 0.08), mats["matte_black"], root, 0.001)
    binding(round_cover, "cleaning_machine_round_cover", "status.wash_side_cover")

    # Extra pipe density and pump bases.
    for idx, x in enumerate([-1.2, -0.55, 0.1, 0.75, 1.4], start=1):
        cube(f"wash_v4_pump_base_bolt_plate_{idx:02d}", (x, -0.98, 0.17), (0.24, 0.18, 0.018), mats["track_steel"], root, 0.001)
    add_warning_labels("wash_v4_cabinet", root, mats, [(-1.85, -1.0, 0.36), (-0.18, -0.748, 0.42)], "y")
    return root


def build_transfer_cart_v4(mats):
    root = base.make_empty("photo_transfer_cart_v4_root")
    relink_model(root, "photo_transfer_cart_v4", "实拍修正版 取料小车 V4")

    cube("cart_v4_heavy_black_track_chassis", (0, 0, 0.16), (3.25, 1.48, 0.24), mats["matte_black"], root, 0.004)
    cube("cart_v4_top_black_machine_frame", (0.05, 0.0, 0.62), (2.38, 1.04, 0.12), mats["matte_black"], root, 0.002)
    for x in [-1.06, 1.1]:
        for y in [-0.48, 0.48]:
            cube(f"cart_v4_transfer_frame_post_{x}_{y}", (x, y, 0.86), (0.085, 0.085, 0.68), mats["matte_black"], root, 0.002)
    cube("cart_v4_upper_transfer_bridge_left", (0.02, -0.5, 1.19), (2.34, 0.08, 0.08), mats["matte_black"], root, 0.002)
    cube("cart_v4_upper_transfer_bridge_right", (0.02, 0.5, 1.19), (2.34, 0.08, 0.08), mats["matte_black"], root, 0.002)
    cube("cart_v4_upper_transfer_bridge_front", (-1.12, 0.0, 1.19), (0.08, 1.04, 0.08), mats["matte_black"], root, 0.002)
    cube("cart_v4_upper_transfer_bridge_rear", (1.16, 0.0, 1.19), (0.08, 1.04, 0.08), mats["matte_black"], root, 0.002)

    for idx, x in enumerate([-0.85, -0.55, -0.25, 0.05, 0.35, 0.65, 0.95], start=1):
        roller = cyl(f"cart_v4_black_bed_live_roller_{idx:02d}", (x, 0, 1.05), 0.045, 0.92, mats["stainless"], root, 18, "y")
        binding(roller, "cart_roller", "motors.cart_roller_speed")
        cyl(f"cart_v4_roller_bearing_left_{idx:02d}", (x, -0.5, 1.05), 0.062, 0.026, mats["track_steel"], root, 16, "y")
        cyl(f"cart_v4_roller_bearing_right_{idx:02d}", (x, 0.5, 1.05), 0.062, 0.026, mats["track_steel"], root, 16, "y")

    # Tall black furnace-side transfer/lift head seen in the marked photos.
    cube("cart_v4_vertical_black_lift_head_plate", (-1.34, 0.36, 1.26), (0.16, 0.68, 1.82), mats["matte_black"], root, 0.002)
    cube("cart_v4_lift_head_refractory_inner_panel", (-1.43, 0.36, 1.34), (0.025, 0.44, 1.22), mats["black_oil"], root, 0.001)
    for z in [0.72, 0.98, 1.24, 1.5, 1.76]:
        cube(f"cart_v4_lift_head_side_lug_left_{z:.2f}", (-1.455, 0.08, z), (0.028, 0.08, 0.04), mats["track_steel"], root, 0.001)
        cube(f"cart_v4_lift_head_side_lug_right_{z:.2f}", (-1.455, 0.64, z), (0.028, 0.08, 0.04), mats["track_steel"], root, 0.001)
    cyl_between("cart_v4_lift_head_top_round_bar", (-1.46, 0.08, 2.14), (-1.46, 0.64, 2.14), 0.027, mats["stainless"], root, 12)
    base.make_motor("cart_v4_lift_head_side_motor", (-1.25, -0.12, 1.36), mats, root, axis="y", scale=0.62, color_key="motor_green")

    # Front electrical cabinet and operator side from the close photo.
    cube("cart_v4_front_electrical_cabinet_box", (-0.55, -0.76, 0.73), (0.92, 0.2, 0.86), mats["cabinet_ivory"], root, 0.003)
    cube("cart_v4_front_cabinet_black_plinth", (-0.55, -0.78, 0.26), (0.94, 0.22, 0.13), mats["matte_black"], root, 0.001)
    cube("cart_v4_cabinet_door_seam", (-0.55, -0.872, 0.73), (0.84, 0.012, 0.012), mats["sheet_shadow"], root, 0)
    add_warning_labels("cart_v4_cabinet", root, mats, [(-0.66, -0.88, 0.54), (-0.42, -0.88, 0.54)], "y")
    add_operator_buttons("cart_v4_top_console", root, mats, (-0.86, -0.77, 1.19), 8, 0.11)
    sphere("cart_v4_red_beacon", (-0.62, -0.76, 1.36), 0.07, mats["orange"], root, 16)

    # Yellow guard rail is around the operator/walkway side, not a decorative cage over the whole cart.
    rail_posts = [(-1.32, -0.92), (-0.65, -0.92), (0.25, -0.92), (0.92, -0.92), (1.18, -0.34)]
    for idx, (x, y) in enumerate(rail_posts, start=1):
        cyl(f"cart_v4_operator_yellow_post_{idx:02d}", (x, y, 0.78), 0.025, 1.12, mats["rail_yellow"], root, 12)
        cube(f"cart_v4_operator_post_floor_plate_{idx:02d}", (x, y, 0.235), (0.13, 0.13, 0.018), mats["rail_yellow"], root, 0.002)
    cyl_between("cart_v4_operator_front_top_rail", (-1.32, -0.92, 1.34), (0.92, -0.92, 1.34), 0.028, mats["rail_yellow"], root, 12)
    cyl_between("cart_v4_operator_front_mid_rail", (-1.32, -0.92, 1.02), (0.92, -0.92, 1.02), 0.021, mats["rail_yellow"], root, 12)
    cyl_between("cart_v4_operator_side_top_rail", (0.92, -0.92, 1.34), (1.18, -0.34, 1.34), 0.028, mats["rail_yellow"], root, 12)
    cyl_between("cart_v4_operator_side_mid_rail", (0.92, -0.92, 1.02), (1.18, -0.34, 1.02), 0.021, mats["rail_yellow"], root, 12)

    # Drive, handwheels, cables, and rails.
    base.make_motor("cart_v4_underframe_drive_motor", (0.58, 0.58, 0.44), mats, root, axis="x", scale=0.55, color_key="motor_green")
    cyl("cart_v4_handwheel_left", (-0.14, -0.57, 0.78), 0.085, 0.018, mats["stainless"], root, 18, "y")
    cyl("cart_v4_handwheel_right", (0.12, -0.57, 0.78), 0.085, 0.018, mats["stainless"], root, 18, "y")
    cyl_between("cart_v4_black_cable_loop", (-1.08, -0.2, 0.54), (-0.28, -0.66, 0.42), 0.014, mats["rubber_hose"], root, 10)
    cube("cart_v4_side_chain_cover", (0.72, 0.58, 0.78), (0.92, 0.075, 0.18), mats["track_steel"], root, 0.003)
    for i in range(12):
        cube(f"cart_v4_chain_link_{i+1:02d}", (0.28 + i * 0.07, 0.63, 0.82), (0.045, 0.018, 0.026), mats["stainless"], root, 0.001)

    for y in [-0.72, 0.72]:
        cube(f"cart_v4_track_flat_rail_{y}", (0, y, -0.035), (3.7, 0.055, 0.04), mats["track_steel"], root, 0.001)
        for i in range(9):
            cube(f"cart_v4_track_sleeper_{y}_{i:02d}", (-1.62 + i * 0.4, y, -0.09), (0.08, 0.28, 0.032), mats["dirty_edge"], root, 0.001)
    for x in [-1.22, -0.48, 0.34, 1.18]:
        for y in [-0.72, 0.72]:
            cyl(f"cart_v4_flanged_track_wheel_{x}_{y}", (x, y, 0.045), 0.112, 0.07, mats["track_steel"], root, 20, "y")
            cyl(f"cart_v4_wheel_hub_{x}_{y}", (x, y, 0.045), 0.046, 0.086, mats["stainless"], root, 16, "y")
    harden_edges(root)
    return root


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def render_preview_v4(scene, cam, roots, root, file_path):
    old_locations = {item.name: item.location.copy() for item in roots}
    for item in roots:
        item.location = (0, 0, 0) if item == root else item.location
        for obj in all_children(item):
            obj.hide_render = item != root
            obj.hide_viewport = item != root
    bpy.context.view_layer.update()
    mins, maxs = base.world_bounds(root)
    center = (mins + maxs) * 0.5
    size = max((maxs - mins).x, (maxs - mins).y, (maxs - mins).z, 1.0)
    model_id = root["model_id"]
    if "tempering" in model_id:
        offset = Vector((-size * 1.6, -size * 0.85, size * 0.72))
        lens = 45
    elif "washing" in model_id:
        offset = Vector((size * 1.22, -size * 1.48, size * 0.82))
        lens = 43
    elif "cart" in model_id:
        offset = Vector((size * 1.22, -size * 1.55, size * 0.78))
        lens = 44
    else:
        offset = Vector((size * 1.16, -size * 1.45, size * 0.84))
        lens = 43
    cam.location = center + offset
    look_at(cam, center + Vector((0, 0, size * 0.04)))
    cam.data.lens = lens
    scene.render.filepath = str(file_path)
    bpy.ops.render.render(write_still=True)
    for item in roots:
        item.location = old_locations[item.name]
        for obj in all_children(item):
            obj.hide_render = False
            obj.hide_viewport = False
    bpy.context.view_layer.update()


def render_asset_overview(scene, cam, roots, file_path):
    for item in roots:
        for obj in all_children(item):
            obj.hide_render = False
            obj.hide_viewport = False
    bpy.context.view_layer.update()
    mins, maxs = base.world_bounds(roots[0])
    for root in roots[1:]:
        a, b = base.world_bounds(root)
        mins.x, mins.y, mins.z = min(mins.x, a.x), min(mins.y, a.y), min(mins.z, a.z)
        maxs.x, maxs.y, maxs.z = max(maxs.x, b.x), max(maxs.y, b.y), max(maxs.z, b.z)
    center = (mins + maxs) * 0.5
    size = max((maxs - mins).x, (maxs - mins).y, (maxs - mins).z, 1.0)
    cam.location = center + Vector((size * 0.38, -size * 1.25, size * 0.9))
    look_at(cam, center + Vector((0, 0, size * 0.02)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = size * 1.55
    scene.render.filepath = str(file_path)
    bpy.ops.render.render(write_still=True)
    cam.data.type = "PERSP"


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    scene = base.new_scene()
    mats = make_v4_materials()
    cam = base.setup_lighting(scene)
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1050
    cube("photo_v4_factory_floor", (0, 0, -0.08), (11.6, 5.4, 0.08), mats["dark_gray"], None, 0)

    multi = refine_multipurpose(v3.add_multipurpose_v3_details(v2.detail_multipurpose(base.build_multipurpose_furnace(mats), mats), mats), mats)
    temper = refine_tempering(v3.add_tempering_v3_details(v2.detail_tempering(base.build_tempering_furnace(mats), mats), mats), mats)
    wash = refine_washing(v3.add_washing_v3_details(v2.detail_washing(base.build_washing_machine(mats), mats), mats), mats)
    cart = build_transfer_cart_v4(mats)
    roots = [multi, temper, wash, cart]

    overview_positions = {
        "photo_multipurpose_furnace_v4": (-4.25, -1.95, 0),
        "photo_tempering_furnace_v4": (3.75, -1.95, 0),
        "photo_washing_machine_v4": (-4.25, 2.55, 0),
        "photo_transfer_cart_v4": (3.75, 2.55, 0),
    }
    for root in roots:
        root.location = overview_positions[root["model_id"]]

    outputs = {}
    for root in roots:
        model_id = root["model_id"]
        glb_path = OUTPUT_DIR / f"{model_id}.glb"
        preview_path = OUTPUT_DIR / f"{model_id}_preview.png"
        base.export_glb(root, glb_path)
        render_preview_v4(scene, cam, roots, root, preview_path)
        outputs[model_id] = {
            "glb": str(glb_path),
            "preview": str(preview_path),
            "object_count": len(all_children(root)),
            "mesh_count": sum(1 for obj in all_children(root) if obj.type == "MESH"),
        }

    overview_path = OUTPUT_DIR / "photo_equipment_models_v4_overview.png"
    render_asset_overview(scene, cam, roots, overview_path)
    blend_path = OUTPUT_DIR / "photo_equipment_models_v4.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    outputs["_overview"] = str(overview_path)
    outputs["_blend"] = str(blend_path)
    print("PHOTO_EQUIPMENT_MODEL_V4_OUTPUTS=" + repr(outputs))
