import importlib.util
import math
import os
from pathlib import Path

import bpy
from mathutils import Vector


OUTPUT_DIR = Path(os.environ.get("CODEX_PHOTO_MODEL_V2_OUT", r"C:\Users\27323\AppData\Local\Temp\codex_photo_equipment_models_v2"))
BASE_SCRIPT = Path(os.environ.get("CODEX_PHOTO_MODEL_BASE_SCRIPT", r"C:\Users\27323\AppData\Local\Temp\codex_photo_equipment_models\blender_generate_photo_equipment_models.py"))


def load_base_module():
    spec = importlib.util.spec_from_file_location("photo_equipment_base", BASE_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = load_base_module()


def mat(name, color, roughness=0.5, metallic=0.0, alpha=1.0):
    return base.mat(name, color, roughness, metallic, alpha)


def make_v2_materials():
    mats = base.make_materials()
    mats.update({
        "seam": mat("photo_v2_dark_panel_seam", (0.035, 0.037, 0.036, 1), 0.55),
        "rubber": mat("photo_v2_black_rubber", (0.02, 0.018, 0.016, 1), 0.7),
        "bolt": mat("photo_v2_dark_bolt", (0.12, 0.13, 0.13, 1), 0.38, 0.55),
        "label_white": mat("photo_v2_label_white", (0.98, 0.98, 0.92, 1), 0.42),
        "caution_black": mat("photo_v2_caution_black", (0.015, 0.015, 0.012, 1), 0.45),
        "brand_red": mat("photo_v2_brand_red", (0.95, 0.06, 0.04, 1), 0.35),
        "dirty_edge": mat("photo_v2_dirty_edge_gray", (0.33, 0.35, 0.33, 1), 0.75),
        "grating": mat("photo_v2_platform_grating", (0.82, 0.54, 0.04, 1), 0.55, 0.08),
        "copper": mat("photo_v2_copper_brass", (0.75, 0.42, 0.12, 1), 0.35, 0.45),
    })
    return mats


def cube(name, loc, scale, material, parent=None, bevel=0.0, rot=(0, 0, 0)):
    obj = base.cube(name, loc, scale, material, parent, bevel)
    obj.rotation_euler = rot
    return obj


def cyl(name, loc, radius, depth, material, parent=None, vertices=20, axis="z"):
    return base.cyl(name, loc, radius, depth, material, parent, vertices, axis, True)


def cyl_between(name, start, end, radius, material, parent=None, vertices=14):
    return base.cyl_between(name, start, end, radius, material, parent, vertices)


def sphere(name, loc, radius, material, parent=None, segments=14):
    return base.sphere(name, loc, radius, material, parent, segments)


def text(name, body, loc, rot, size, material, parent=None, align="CENTER"):
    return base.text_mesh(name, body, loc, rot, size, material, parent, align)


def binding(obj, role, point_hint=""):
    return base.set_binding(obj, role, point_hint)


def all_children(root):
    return base.all_children(root)


def add_bolts(prefix, parent, mats, locs, radius=0.024, axis="y"):
    for idx, loc in enumerate(locs, start=1):
        bolt = cyl(f"{prefix}_bolt_{idx:02d}", loc, radius, radius * 0.45, mats["bolt"], parent, 12, axis)
        binding(bolt, "fastener", "")


def add_rect_bolts(prefix, parent, mats, x0, x1, z0, z1, y, count_x=5, count_z=3, radius=0.018):
    locs = []
    for i in range(count_x):
        x = x0 + (x1 - x0) * i / max(count_x - 1, 1)
        locs.append((x, y, z0))
        locs.append((x, y, z1))
    for i in range(1, count_z - 1):
        z = z0 + (z1 - z0) * i / max(count_z - 1, 1)
        locs.append((x0, y, z))
        locs.append((x1, y, z))
    add_bolts(prefix, parent, mats, locs, radius, "y")


def add_panel_seams(prefix, parent, mats, x0, x1, z0, z1, y, verticals=4, horizontals=3):
    for i in range(1, verticals):
        x = x0 + (x1 - x0) * i / verticals
        cube(f"{prefix}_vertical_seam_{i:02d}", (x, y, (z0 + z1) / 2), (0.018, 0.026, z1 - z0), mats["seam"], parent, 0.002)
    for i in range(1, horizontals):
        z = z0 + (z1 - z0) * i / horizontals
        cube(f"{prefix}_horizontal_seam_{i:02d}", ((x0 + x1) / 2, y, z), (x1 - x0, 0.026, 0.018), mats["seam"], parent, 0.002)


def add_grille(prefix, parent, mats, center, width, height, y, bars=7):
    x0 = center[0] - width / 2
    for i in range(bars):
        x = x0 + width * (i + 0.5) / bars
        cube(f"{prefix}_vent_bar_{i+1:02d}", (x, y, center[2]), (width / (bars * 2.2), 0.028, height), mats["seam"], parent, 0.003)
    cube(f"{prefix}_vent_frame_top", (center[0], y, center[2] + height / 2), (width, 0.032, 0.018), mats["seam"], parent, 0.002)
    cube(f"{prefix}_vent_frame_bottom", (center[0], y, center[2] - height / 2), (width, 0.032, 0.018), mats["seam"], parent, 0.002)


def add_platform_grating(prefix, parent, mats, x0, x1, y0, y1, z, bars_x=7, bars_y=4):
    for i in range(bars_x):
        x = x0 + (x1 - x0) * (i + 0.5) / bars_x
        cube(f"{prefix}_grating_long_{i+1:02d}", (x, (y0 + y1) / 2, z + 0.008), (0.018, y1 - y0, 0.018), mats["grating"], parent, 0.002)
    for i in range(bars_y):
        y = y0 + (y1 - y0) * (i + 0.5) / bars_y
        cube(f"{prefix}_grating_cross_{i+1:02d}", ((x0 + x1) / 2, y, z + 0.012), (x1 - x0, 0.016, 0.014), mats["grating"], parent, 0.002)


def add_motor_fins(prefix, parent, mats, loc, axis="x", count=7, scale=1.0):
    if axis == "x":
        for i in range(count):
            x = loc[0] - 0.14 * scale + i * 0.28 * scale / max(count - 1, 1)
            cube(f"{prefix}_cooling_fin_{i+1:02d}", (x, loc[1], loc[2] + 0.19 * scale), (0.018, 0.32 * scale, 0.035 * scale), mats["dirty_edge"], parent, 0.004)
    elif axis == "y":
        for i in range(count):
            y = loc[1] - 0.14 * scale + i * 0.28 * scale / max(count - 1, 1)
            cube(f"{prefix}_cooling_fin_{i+1:02d}", (loc[0], y, loc[2] + 0.19 * scale), (0.32 * scale, 0.018, 0.035 * scale), mats["dirty_edge"], parent, 0.004)
    else:
        for i in range(count):
            z = loc[2] - 0.14 * scale + i * 0.28 * scale / max(count - 1, 1)
            cube(f"{prefix}_cooling_fin_{i+1:02d}", (loc[0] + 0.19 * scale, loc[1], z), (0.035 * scale, 0.32 * scale, 0.018), mats["dirty_edge"], parent, 0.004)


def add_warning_label(prefix, parent, mats, loc, size=(0.28, 0.02, 0.14), axis="front"):
    label = cube(f"{prefix}_warning_label_plate", loc, size, mats["label_white"], parent, 0.004)
    stripe_count = 3
    for i in range(stripe_count):
        stripe = cube(
            f"{prefix}_warning_label_yellow_stripe_{i+1:02d}",
            (loc[0] - size[0] * 0.28 + i * size[0] * 0.28, loc[1] - 0.002, loc[2]),
            (size[0] * 0.16, size[1] * 1.2, size[2] * 0.7),
            mats["rail_yellow"],
            parent,
            0.002,
            rot=(0, 0, math.radians(20)),
        )
    return label


def add_cable(prefix, parent, mats, points, radius=0.018):
    for idx in range(len(points) - 1):
        cyl_between(f"{prefix}_cable_segment_{idx+1:02d}", points[idx], points[idx + 1], radius, mats["rubber"], parent, 10)


def add_pipe_elbow(prefix, parent, mats, loc, radius=0.055, material_key="pipe_green"):
    sphere(f"{prefix}_elbow", loc, radius, mats[material_key], parent, 12)


def detail_multipurpose(root, mats):
    root.name = "photo_multipurpose_furnace_v2_root"
    root["model_id"] = "photo_multipurpose_furnace_v2"
    root["model_label"] = "Photo Multipurpose Furnace V2"

    add_panel_seams("multi_v2_side_shell", root, mats, -1.35, 1.55, 0.58, 1.98, -0.795, 6, 4)
    add_rect_bolts("multi_v2_rear_chamber_flange", root, mats, -1.3, 1.55, 0.54, 2.02, -0.822, 7, 4)
    add_rect_bolts("multi_v2_front_black_frame", root, mats, 2.26, 2.47, 0.34, 1.82, -0.86, 2, 7, 0.016)
    add_grille("multi_v2_cabinet_lower_vent", root, mats, (-2.25, 1.06, 0.55), 0.38, 0.32, -1.055, 7)
    add_grille("multi_v2_cabinet_upper_vent", root, mats, (-2.25, 1.06, 1.68), 0.36, 0.26, -1.055, 6)
    add_warning_label("multi_v2_cabinet", root, mats, (-2.25, -1.067, 0.68), (0.38, 0.018, 0.16))
    text("multi_v2_cabinet_hmi_diagram", "PLC", (-2.25, -1.062, 1.42), (math.radians(90), 0, 0), 0.06, mats["label_white"], root)
    text("multi_v2_brand_name", "KINGKIND", (2.2, -0.965, 2.56), (math.radians(90), 0, 0), 0.12, mats["brand_red"], root)

    for x in [-1.55, -1.15, -0.75, -0.35, 0.05, 0.45, 0.85, 1.25]:
        add_pipe_elbow(f"multi_v2_gas_elbow_{x:.2f}", root, mats, (x, -0.96, 0.58), 0.04, "pipe_yellow")
        cube(f"multi_v2_valve_tag_{x:.2f}", (x, -1.035, 0.94), (0.11, 0.012, 0.05), mats["label_white"], root, 0.002)
    for idx, x in enumerate([-1.55, -1.05, -0.55, -0.05, 0.45, 0.95, 1.45], start=1):
        make_loc = (x, -1.01, 0.46)
        cyl(f"multi_v2_brass_union_{idx:02d}", make_loc, 0.045, 0.08, mats["copper"], root, 12, "x")

    for idx, (loc, axis, scale) in enumerate([
        ((-0.4, -0.92, 1.15), "y", 0.82),
        ((0.28, -0.92, 1.68), "y", 0.82),
        ((0.96, -0.92, 2.08), "y", 0.82),
        ((-0.88, -0.86, 0.62), "z", 0.92),
    ], start=1):
        add_motor_fins(f"multi_v2_motor_{idx:02d}", root, mats, loc, axis, 8, scale)
        add_cable(f"multi_v2_motor_{idx:02d}", root, mats, [loc, (loc[0] - 0.24, -1.02, loc[2] - 0.16), (loc[0] - 0.5, -1.02, 0.58)], 0.014)

    add_platform_grating("multi_v2_upper_platform", root, mats, -2.1, -0.75, 0.5, 1.14, 2.28, 7, 3)
    for z in [0.42, 0.86, 1.3, 1.74]:
        cube(f"multi_v2_ladder_shadow_step_{z:.2f}", (-2.22, 0.78, z), (0.08, 0.62, 0.012), mats["dirty_edge"], root, 0.002)
    cube("multi_v2_front_door_inner_glow_panel", (2.505, -0.03, 1.12), (0.018, 0.68, 0.58), mats["glass"], root, 0.006)
    cube("multi_v2_black_door_handle", (2.535, -0.46, 1.28), (0.06, 0.035, 0.42), mats["steel"], root, 0.006)
    add_cable("multi_v2_floor_cable_bundle", root, mats, [(-0.8, -1.03, 0.22), (0.2, -1.12, 0.22), (1.45, -1.08, 0.32), (2.25, -0.82, 0.78)], 0.02)
    return root


def detail_tempering(root, mats):
    root.name = "photo_tempering_furnace_v2_root"
    root["model_id"] = "photo_tempering_furnace_v2"
    root["model_label"] = "Photo Tempering Furnace V2"

    cube("temper_v2_front_door_inner_plate", (-1.505, -0.02, 1.23), (0.04, 0.9, 1.12), mats["black"], root, 0.02)
    add_rect_bolts("temper_v2_door_bolts", root, mats, -1.53, -1.53, 0.62, 1.86, -0.49, 1, 7, 0.018)
    add_rect_bolts("temper_v2_door_bolts_right", root, mats, -1.53, -1.53, 0.62, 1.86, 0.49, 1, 7, 0.018)
    for y in [-0.54, 0.54]:
        cube(f"temper_v2_door_chain_{y}", (-1.56, y, 1.38), (0.032, 0.032, 1.45), mats["seam"], root, 0.006)
        for i in range(9):
            cube(f"temper_v2_chain_link_{y}_{i:02d}", (-1.58, y, 0.72 + i * 0.14), (0.054, 0.026, 0.018), mats["steel"], root, 0.003)
    add_panel_seams("temper_v2_side_panel", root, mats, -0.42, 1.18, 0.38, 2.12, 0.708, 5, 4)
    add_rect_bolts("temper_v2_side_panel_bolts", root, mats, -0.42, 1.18, 0.38, 2.12, 0.74, 6, 4, 0.014)
    text("temper_v2_brand_name", "KINGKIND", (-1.18, -0.885, 2.54), (math.radians(90), 0, 0), 0.12, mats["brand_red"], root)
    add_grille("temper_v2_side_motor_grille", root, mats, (0.52, -1.05, 1.62), 0.55, 0.5, -0.89, 8)
    add_motor_fins("temper_v2_door_motor", root, mats, (-1.34, -0.86, 1.98), "y", 7, 0.75)
    add_platform_grating("temper_v2_side_platform", root, mats, 0.55, 1.52, 0.56, 1.34, 2.11, 5, 3)
    add_warning_label("temper_v2_side_warning", root, mats, (0.28, -0.715, 0.92), (0.28, 0.018, 0.18))
    for x in [-0.8, -0.2, 0.4, 1.0]:
        cube(f"temper_v2_lower_base_foot_{x:.1f}", (x, -0.62, 0.02), (0.16, 0.14, 0.08), mats["steel"], root, 0.012)
        cube(f"temper_v2_lower_base_foot_back_{x:.1f}", (x, 0.62, 0.02), (0.16, 0.14, 0.08), mats["steel"], root, 0.012)
    return root


def detail_washing(root, mats):
    root.name = "photo_washing_machine_v2_root"
    root["model_id"] = "photo_washing_machine_v2"
    root["model_label"] = "Photo Washing Machine V2"

    add_panel_seams("wash_v2_tank_side", root, mats, -1.1, 1.72, 0.34, 1.14, -0.705, 6, 3)
    add_panel_seams("wash_v2_upper_side", root, mats, -0.45, 1.72, 1.18, 2.08, -0.625, 5, 3)
    add_rect_bolts("wash_v2_upper_bolts", root, mats, -0.45, 1.72, 1.18, 2.08, -0.648, 6, 4, 0.014)
    add_grille("wash_v2_cabinet_vent", root, mats, (-1.85, -0.965, 0.72), 0.34, 0.32, -0.95, 7)
    add_warning_label("wash_v2_cabinet_warning", root, mats, (-1.85, -0.965, 0.48), (0.32, 0.018, 0.14))
    text("wash_v2_brand_name", "KINGKIND", (-1.85, -0.965, 1.68), (math.radians(90), 0, 0), 0.07, mats["brand_red"], root)

    for idx, x in enumerate([-1.1, -0.28, 0.55, 1.34], start=1):
        add_motor_fins(f"wash_v2_pump_{idx:02d}", root, mats, (x, -0.98, 0.34), "x", 9, 0.72)
        cube(f"wash_v2_pump_base_{idx:02d}", (x, -0.98, 0.13), (0.46, 0.34, 0.08), mats["motor_blue"], root, 0.012)
        for dx in [-0.16, 0.16]:
            for dy in [-0.12, 0.12]:
                cyl(f"wash_v2_pump_anchor_{idx:02d}_{dx}_{dy}", (x + dx, -0.98 + dy, 0.19), 0.014, 0.012, mats["bolt"], root, 10, "z")

    for idx, (x, z) in enumerate([(-0.75, 0.86), (-0.18, 1.24), (0.42, 0.86), (1.05, 1.24), (1.48, 0.86)], start=1):
        add_pipe_elbow(f"wash_v2_pipe_elbow_{idx:02d}", root, mats, (x, -1.02, z), 0.055, "pipe_green")
        cyl(f"wash_v2_flange_{idx:02d}_a", (x - 0.07, -1.02, z), 0.06, 0.018, mats["copper"], root, 16, "x")
        cyl(f"wash_v2_flange_{idx:02d}_b", (x + 0.07, -1.02, z), 0.06, 0.018, mats["copper"], root, 16, "x")
    for x in [-0.6, 0.2, 1.0]:
        add_rect_bolts(f"wash_v2_filter_mount_{x:.1f}", root, mats, x - 0.12, x + 0.12, 0.98, 1.36, -0.91, 2, 3, 0.012)
    add_platform_grating("wash_v2_upper_platform", root, mats, -1.28, 1.5, 0.54, 1.12, 2.41, 8, 3)
    for x in [-0.2, 0.88]:
        cube(f"wash_v2_orange_lid_handle_{x:.1f}", (x, -0.38 if x < 0 else 0.38, 2.28), (0.38, 0.06, 0.055), mats["dirty_edge"], root, 0.01)
    add_cable("wash_v2_pump_cable_bundle", root, mats, [(-1.3, -1.12, 0.3), (-0.2, -1.18, 0.28), (0.9, -1.14, 0.3), (1.62, -1.02, 0.58)], 0.016)
    return root


def detail_cart(root, mats):
    root.name = "photo_transfer_cart_v2_root"
    root["model_id"] = "photo_transfer_cart_v2"
    root["model_label"] = "Photo Transfer Cart V2"

    for i, x in enumerate([-0.35, -0.05, 0.25, 0.55, 0.85], start=1):
        cyl(f"cart_v2_roller_end_cap_left_{i:02d}", (x, -0.53, 0.84), 0.055, 0.025, mats["bolt"], root, 14, "y")
        cyl(f"cart_v2_roller_end_cap_right_{i:02d}", (x, 0.53, 0.84), 0.055, 0.025, mats["bolt"], root, 14, "y")
    for x in [-1.05, -0.25, 0.55, 1.15]:
        for y in [-0.72, 0.72]:
            cyl(f"cart_v2_wheel_rim_{x:.1f}_{y:.1f}", (x, y, 0.02), 0.085, 0.09, mats["steel"], root, 18, "y")
            cyl(f"cart_v2_wheel_hub_{x:.1f}_{y:.1f}", (x, y, 0.02), 0.035, 0.105, mats["bolt"], root, 14, "y")
    add_motor_fins("cart_v2_side_drive_motor", root, mats, (1.36, 0.55, 0.62), "y", 8, 0.65)
    add_motor_fins("cart_v2_lower_drive_motor", root, mats, (0.72, 0.68, 0.23), "x", 6, 0.52)
    cube("cart_v2_drive_chain_guard", (0.96, 0.66, 0.46), (0.62, 0.07, 0.18), mats["rubber"], root, 0.012)
    for i in range(8):
        cube(f"cart_v2_chain_link_{i+1:02d}", (0.68 + i * 0.07, 0.705, 0.46), (0.045, 0.018, 0.035), mats["steel"], root, 0.003)
    add_rect_bolts("cart_v2_front_panel_bolts", root, mats, -1.12, -0.32, 0.34, 1.08, -0.646, 4, 4, 0.014)
    add_warning_label("cart_v2_front_panel_warning", root, mats, (-0.72, -0.652, 0.64), (0.32, 0.018, 0.14))
    add_platform_grating("cart_v2_roller_bed_grating", root, mats, -0.45, 1.15, -0.52, 0.52, 0.93, 6, 4)
    for x in [-1.18, -0.48, 0.32, 1.18]:
        for y in [-0.8, 0.8]:
            cyl(f"cart_v2_guard_base_plate_{x:.1f}_{y:.1f}", (x, y, 0.26), 0.07, 0.018, mats["rail_yellow"], root, 14, "z")
            add_bolts(f"cart_v2_guard_base_{x:.1f}_{y:.1f}", root, mats, [(x - 0.035, y, 0.272), (x + 0.035, y, 0.272)], 0.009, "z")
    add_cable("cart_v2_motor_cable", root, mats, [(1.36, 0.55, 0.62), (1.18, 0.82, 0.42), (0.62, 0.82, 0.28), (-0.55, 0.76, 0.36)], 0.015)
    return root


def move_root_for_overview(root, location):
    root.location = location


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    scene = base.new_scene()
    mats = make_v2_materials()
    cam = base.setup_lighting(scene)
    cube("photo_v2_factory_floor", (0, 0, -0.08), (10.2, 4.8, 0.08), mats["dark_gray"], None, 0)

    builders = [
        ("photo_multipurpose_furnace_v2", "实拍参考-箱式气氛多用炉 V2", lambda: detail_multipurpose(base.build_multipurpose_furnace(mats), mats)),
        ("photo_tempering_furnace_v2", "实拍参考-回火炉 V2", lambda: detail_tempering(base.build_tempering_furnace(mats), mats)),
        ("photo_washing_machine_v2", "实拍参考-清洗机 V2", lambda: detail_washing(base.build_washing_machine(mats), mats)),
        ("photo_transfer_cart_v2", "实拍参考-料车/取料小车 V2", lambda: detail_cart(base.build_transfer_cart(mats), mats)),
    ]
    roots = []
    outputs = {}
    for model_id, label, builder in builders:
        root = builder()
        root["model_id"] = model_id
        root["model_label"] = label
        root["detail_level"] = "v2_industrial_showcase"
        roots.append(root)

    overview_positions = {
        "photo_multipurpose_furnace_v2": (-2.6, -0.82, 0),
        "photo_tempering_furnace_v2": (2.1, -0.82, 0),
        "photo_washing_machine_v2": (-2.35, 1.45, 0),
        "photo_transfer_cart_v2": (2.22, 1.45, 0),
    }
    for root in roots:
        move_root_for_overview(root, overview_positions[root["model_id"]])

    for root in roots:
        model_id = root["model_id"]
        glb_path = OUTPUT_DIR / f"{model_id}.glb"
        preview_path = OUTPUT_DIR / f"{model_id}_preview.png"
        base.export_glb(root, glb_path)
        base.render_preview(scene, cam, roots, root, preview_path)
        outputs[model_id] = {
            "glb": str(glb_path),
            "preview": str(preview_path),
            "object_count": len(all_children(root)),
            "mesh_count": sum(1 for obj in all_children(root) if obj.type == "MESH"),
        }

    overview_path = OUTPUT_DIR / "photo_equipment_models_v2_overview.png"
    base.render_overview(scene, cam, roots, overview_path)
    blend_path = OUTPUT_DIR / "photo_equipment_models_v2.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    outputs["_overview"] = str(overview_path)
    outputs["_blend"] = str(blend_path)
    print("PHOTO_EQUIPMENT_MODEL_V2_OUTPUTS=" + repr(outputs))
    return outputs


if __name__ == "__main__":
    main()
