import importlib.util
import math
import os
from pathlib import Path

import bpy
from mathutils import Vector


OUTPUT_DIR = Path(os.environ.get("CODEX_PHOTO_MODEL_V3_OUT", r"C:\Users\27323\AppData\Local\Temp\codex_photo_equipment_models_v3"))
V2_SCRIPT = Path(os.environ.get("CODEX_PHOTO_MODEL_V2_SCRIPT", r"C:\Users\27323\AppData\Local\Temp\codex_photo_equipment_models_v2\blender_generate_photo_equipment_models_v2.py"))


def load_v2_module():
    spec = importlib.util.spec_from_file_location("photo_equipment_v2", V2_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


v2 = load_v2_module()
base = v2.base


def mat(name, color, roughness=0.5, metallic=0.0, alpha=1.0):
    return base.mat(name, color, roughness, metallic, alpha)


def make_v3_materials():
    mats = v2.make_v2_materials()
    mats.update({
        "paint_edge": mat("photo_v3_paint_edge_highlight", (0.78, 0.80, 0.76, 1), 0.6),
        "dark_inner": mat("photo_v3_dark_inner_cavity", (0.006, 0.006, 0.005, 1), 0.7),
        "warm_glow": mat("photo_v3_subtle_heat_glow", (1.0, 0.36, 0.08, 1), 0.25),
        "brass": mat("photo_v3_brass_fittings", (0.74, 0.45, 0.16, 1), 0.32, 0.55),
        "rubber_hose": mat("photo_v3_rubber_hose", (0.012, 0.012, 0.011, 1), 0.78),
        "dark_glass": mat("photo_v3_dark_glass", (0.02, 0.12, 0.16, 0.55), 0.15, 0.0, 0.55),
        "stainless": mat("photo_v3_stainless_pipe", (0.72, 0.75, 0.74, 1), 0.22, 0.85),
        "oil_dark": mat("photo_v3_dark_oil_surface", (0.02, 0.018, 0.014, 1), 0.18),
        "rubber_gray": mat("photo_v3_rubber_gray", (0.12, 0.13, 0.13, 1), 0.7),
        "small_label": mat("photo_v3_small_label", (0.95, 0.92, 0.78, 1), 0.45),
        "wire_red": mat("photo_v3_wire_red", (0.72, 0.03, 0.02, 1), 0.55),
        "wire_blue": mat("photo_v3_wire_blue", (0.02, 0.12, 0.58, 1), 0.55),
    })
    return mats


def cube(name, loc, scale, material, parent=None, bevel=0.0, rot=(0, 0, 0)):
    obj = v2.cube(name, loc, scale, material, parent, bevel, rot)
    return obj


def cyl(name, loc, radius, depth, material, parent=None, vertices=20, axis="z"):
    return v2.cyl(name, loc, radius, depth, material, parent, vertices, axis)


def cyl_between(name, start, end, radius, material, parent=None, vertices=14):
    return v2.cyl_between(name, start, end, radius, material, parent, vertices)


def sphere(name, loc, radius, material, parent=None, segments=14):
    return v2.sphere(name, loc, radius, material, parent, segments)


def text(name, body, loc, rot, size, material, parent=None, align="CENTER"):
    return v2.text(name, body, loc, rot, size, material, parent, align)


def binding(obj, role, point_hint=""):
    return base.set_binding(obj, role, point_hint)


def all_children(root):
    return base.all_children(root)


def add_micro_bolts(prefix, parent, mats, locs, radius=0.012, axis="y"):
    for idx, loc in enumerate(locs, start=1):
        bolt = cyl(f"{prefix}_micro_bolt_{idx:02d}", loc, radius, radius * 0.55, mats["bolt"], parent, 10, axis)
        binding(bolt, "fastener", "")


def add_hinge(prefix, parent, mats, x, y, z, height=0.22, axis="z"):
    leaf_a = cube(f"{prefix}_hinge_leaf_a", (x, y - 0.018, z), (0.045, 0.012, height), mats["stainless"], parent, 0.003)
    leaf_b = cube(f"{prefix}_hinge_leaf_b", (x, y + 0.018, z), (0.045, 0.012, height), mats["stainless"], parent, 0.003)
    pin = cyl(f"{prefix}_hinge_pin", (x, y, z), 0.018, height * 1.08, mats["stainless"], parent, 14, axis)
    binding(pin, "hinge", "")
    return pin


def add_handle(prefix, parent, mats, p1, p2, radius=0.015, standoff=0.06):
    p1v = Vector(p1)
    p2v = Vector(p2)
    offset = Vector((standoff, 0, 0))
    cyl_between(f"{prefix}_handle_bar", p1v + offset, p2v + offset, radius, mats["stainless"], parent, 12)
    cyl_between(f"{prefix}_handle_mount_a", p1v, p1v + offset, radius * 0.75, mats["stainless"], parent, 10)
    cyl_between(f"{prefix}_handle_mount_b", p2v, p2v + offset, radius * 0.75, mats["stainless"], parent, 10)


def add_cable_chain(prefix, parent, mats, start, end, links=12, radius=0.012):
    s = Vector(start)
    e = Vector(end)
    for i in range(links):
        t = i / max(links - 1, 1)
        p = s.lerp(e, t)
        cube(f"{prefix}_chain_link_{i+1:02d}", (p.x, p.y, p.z), (0.055, 0.022, 0.032), mats["rubber_gray"], parent, 0.004)
    cyl_between(f"{prefix}_chain_spine", start, end, radius, mats["rubber_hose"], parent, 10)


def add_perforated_panel(prefix, parent, mats, x0, x1, z0, z1, y, rows=5, cols=8):
    cube(f"{prefix}_perforated_backplate", ((x0 + x1) / 2, y + 0.002, (z0 + z1) / 2), (x1 - x0, 0.012, z1 - z0), mats["paint_edge"], parent, 0.004)
    for r in range(rows):
        for c in range(cols):
            x = x0 + (x1 - x0) * (c + 0.5) / cols
            z = z0 + (z1 - z0) * (r + 0.5) / rows
            cyl(f"{prefix}_perforation_{r+1:02d}_{c+1:02d}", (x, y - 0.006, z), 0.011, 0.008, mats["dark_inner"], parent, 8, "y")


def add_nameplate(prefix, parent, mats, loc, text_body, size=(0.32, 0.018, 0.12), text_size=0.055):
    cube(f"{prefix}_nameplate", loc, size, mats["caution_black"], parent, 0.004)
    text(f"{prefix}_nameplate_text", text_body, (loc[0], loc[1] - 0.012, loc[2] + 0.002), (math.radians(90), 0, 0), text_size, mats["brand_red"], parent)


def add_panel_door(prefix, parent, mats, center, size, y, hinge_side="left"):
    x, _, z = center
    sx, _, sz = size
    panel = cube(f"{prefix}_cabinet_door_panel", (x, y, z), size, mats["panel_white"], parent, 0.015)
    cube(f"{prefix}_cabinet_door_seam_top", (x, y - 0.012, z + sz / 2), (sx, 0.014, 0.012), mats["seam"], parent, 0.002)
    cube(f"{prefix}_cabinet_door_seam_bottom", (x, y - 0.012, z - sz / 2), (sx, 0.014, 0.012), mats["seam"], parent, 0.002)
    hx = x - sx / 2 + 0.03 if hinge_side == "left" else x + sx / 2 - 0.03
    add_hinge(f"{prefix}_hinge_top", parent, mats, hx, y - 0.02, z + sz * 0.28, 0.16, "z")
    add_hinge(f"{prefix}_hinge_bottom", parent, mats, hx, y - 0.02, z - sz * 0.28, 0.16, "z")
    handle_x = x + sx / 2 - 0.08 if hinge_side == "left" else x - sx / 2 + 0.08
    add_handle(f"{prefix}_door_handle", parent, mats, (handle_x, y - 0.03, z - 0.12), (handle_x, y - 0.03, z + 0.12), 0.01, 0.04)
    return panel


def add_pressure_gauge_face(prefix, parent, mats, loc, radius=0.075):
    face = cyl(f"{prefix}_gauge_face", loc, radius, 0.016, mats["label_white"], parent, 24, "y")
    cyl(f"{prefix}_gauge_ring", (loc[0], loc[1] - 0.012, loc[2]), radius * 1.08, 0.012, mats["stainless"], parent, 24, "y")
    for i, ang in enumerate([-55, -28, 0, 28, 55], start=1):
        needle_len = radius * 0.34
        x = loc[0] + math.sin(math.radians(ang)) * radius * 0.44
        z = loc[2] + math.cos(math.radians(ang)) * radius * 0.44
        tick = cube(f"{prefix}_gauge_tick_{i:02d}", (x, loc[1] - 0.024, z), (0.006, 0.004, needle_len * 0.35), mats["bolt"], parent, 0.001, rot=(0, math.radians(ang), 0))
    needle = cube(f"{prefix}_gauge_needle", (loc[0] + 0.018, loc[1] - 0.03, loc[2] + 0.012), (0.008, 0.004, radius * 0.78), mats["wire_red"], parent, 0.001, rot=(0, math.radians(18), 0))
    binding(face, "gauge", f"{prefix}_pressure")
    return face


def add_pipe_clamps(prefix, parent, mats, points, every=0.42, radius=0.04):
    for idx in range(len(points) - 1):
        a = Vector(points[idx])
        b = Vector(points[idx + 1])
        length = (b - a).length
        count = max(1, int(length / every))
        for i in range(1, count + 1):
            t = i / (count + 1)
            p = a.lerp(b, t)
            cube(f"{prefix}_pipe_clamp_{idx+1:02d}_{i:02d}", (p.x, p.y - 0.008, p.z), (radius * 2.2, 0.014, radius * 1.1), mats["stainless"], parent, 0.003)


def add_multipurpose_v3_details(root, mats):
    root.name = "photo_multipurpose_furnace_v3_root"
    root["model_id"] = "photo_multipurpose_furnace_v3"
    root["model_label"] = "实拍参考-箱式气氛多用炉 V3"
    root["detail_level"] = "v3_refined_showcase"

    # Realer front black furnace mouth: nested thermal layers and guide rails.
    cube("multi_v3_front_door_outer_frame_left", (2.53, -0.62, 1.12), (0.055, 0.045, 1.36), mats["stainless"], root, 0.006)
    cube("multi_v3_front_door_outer_frame_right", (2.53, 0.62, 1.12), (0.055, 0.045, 1.36), mats["stainless"], root, 0.006)
    cube("multi_v3_front_door_outer_frame_top", (2.53, 0, 1.82), (0.055, 1.28, 0.052), mats["stainless"], root, 0.006)
    cube("multi_v3_front_door_outer_frame_bottom", (2.53, 0, 0.42), (0.055, 1.28, 0.052), mats["stainless"], root, 0.006)
    cube("multi_v3_front_door_refractory_inner", (2.555, 0, 1.13), (0.022, 0.78, 0.72), mats["warm_glow"], root, 0.004)
    add_handle("multi_v3_front_door", root, mats, (2.58, -0.48, 0.78), (2.58, -0.48, 1.46), 0.014, 0.05)
    for z in [0.5, 0.8, 1.1, 1.4, 1.7]:
        add_micro_bolts(f"multi_v3_black_frame_z{z:.1f}", root, mats, [(2.57, -0.7, z), (2.57, 0.7, z)], 0.013, "x")

    # Side service doors and cabinet-grade detail.
    for idx, x in enumerate([-1.08, -0.36, 0.36, 1.08], start=1):
        add_panel_door(f"multi_v3_side_service_{idx:02d}", root, mats, (x, 0, 1.18), (0.55, 0.022, 1.15), -0.835, "left")
    add_perforated_panel("multi_v3_control_cabinet_top", root, mats, -2.45, -2.05, 1.72, 1.98, -1.065, 4, 6)
    add_panel_door("multi_v3_control_cabinet_lower", root, mats, (-2.25, 0, 0.68), (0.48, 0.024, 0.72), -1.065, "left")
    add_nameplate("multi_v3_brand_front", root, mats, (2.18, -0.972, 2.48), "KINGKIND", (0.52, 0.02, 0.16), 0.064)

    # Denser gas manifold with fittings, flanges, clamp brackets, and labels.
    gas_points = [(-1.8, -0.96, 0.58), (1.65, -0.96, 0.58)]
    add_pipe_clamps("multi_v3_yellow_header", root, mats, gas_points, 0.35, 0.042)
    for idx, x in enumerate([-1.55, -1.15, -0.75, -0.35, 0.05, 0.45, 0.85, 1.25], start=1):
        cyl(f"multi_v3_valve_solenoid_{idx:02d}", (x, -1.02, 1.04), 0.038, 0.1, mats["motor_green"], root, 12, "z")
        cube(f"multi_v3_valve_terminal_{idx:02d}", (x + 0.07, -1.025, 1.02), (0.055, 0.025, 0.07), mats["dark_gray"], root, 0.004)
        cube(f"multi_v3_valve_tag_plate_{idx:02d}", (x, -1.055, 0.91), (0.09, 0.012, 0.045), mats["small_label"], root, 0.002)
        text(f"multi_v3_valve_tag_text_{idx:02d}", f"V{idx}", (x, -1.064, 0.91), (math.radians(90), 0, 0), 0.023, mats["caution_black"], root)
        cyl(f"multi_v3_brass_fitting_upper_{idx:02d}", (x, -0.96, 0.96), 0.032, 0.052, mats["brass"], root, 12, "z")
        cyl_between(f"multi_v3_black_signal_wire_{idx:02d}", (x + 0.07, -1.03, 1.02), (x + 0.18, -1.06, 0.82), 0.007, mats["rubber_hose"], root, 8)
    for idx, x in enumerate([-1.25, -0.55, 0.15, 0.85], start=1):
        add_pressure_gauge_face(f"multi_v3_pressure_gauge_{idx:02d}", root, mats, (x, -1.045, 0.76), 0.065)

    # Oil tank service area, sight glass, drain valve, cable tray.
    cube("multi_v3_oil_tank_sight_glass", (-1.62, -0.86, 0.43), (0.055, 0.018, 0.32), mats["dark_glass"], root, 0.004)
    cube("multi_v3_lower_cable_tray", (0.2, -1.04, 0.19), (3.1, 0.06, 0.052), mats["dark_gray"], root, 0.006)
    for i in range(10):
        cube(f"multi_v3_cable_tray_slot_{i+1:02d}", (-1.15 + i * 0.28, -1.076, 0.205), (0.09, 0.012, 0.018), mats["seam"], root, 0.001)
    cyl_between("multi_v3_oil_drain_pipe", (-1.75, -0.92, 0.31), (-1.75, -1.18, 0.16), 0.025, mats["pipe_yellow"], root, 12)
    sphere("multi_v3_oil_drain_valve", (-1.75, -1.18, 0.16), 0.045, mats["red"], root, 12)

    # Refined upper platform with anti-slip strips and support braces.
    for i in range(6):
        cube(f"multi_v3_upper_platform_anti_slip_{i+1:02d}", (-2.02 + i * 0.22, 0.82, 2.31), (0.035, 0.58, 0.018), mats["dirty_edge"], root, 0.002)
    cyl_between("multi_v3_platform_diagonal_brace_a", (-2.1, 0.52, 2.22), (-0.8, 1.13, 2.95), 0.018, mats["rail_yellow"], root, 10)
    cyl_between("multi_v3_platform_diagonal_brace_b", (-2.1, 1.13, 2.22), (-0.8, 0.52, 2.95), 0.018, mats["rail_yellow"], root, 10)

    # Drive motors: nameplates and terminal boxes.
    motor_locs = [(-0.4, -0.92, 1.15), (0.28, -0.92, 1.68), (0.96, -0.92, 2.08), (-0.88, -0.86, 0.62)]
    for idx, loc in enumerate(motor_locs, start=1):
        cube(f"multi_v3_motor_terminal_box_{idx:02d}", (loc[0] + 0.04, loc[1] - 0.17, loc[2] + 0.17), (0.12, 0.07, 0.085), mats["motor_green"], root, 0.008)
        cube(f"multi_v3_motor_nameplate_{idx:02d}", (loc[0], loc[1] - 0.202, loc[2] - 0.02), (0.16, 0.01, 0.055), mats["small_label"], root, 0.002)
    return root


def add_tempering_v3_details(root, mats):
    root.name = "photo_tempering_furnace_v3_root"
    root["model_id"] = "photo_tempering_furnace_v3"
    root["model_label"] = "实拍参考-回火炉 V3"
    root["detail_level"] = "v3_refined_showcase"

    # Emphasize the real front lift-door assembly.
    cube("temper_v3_front_lift_door_face", (-1.575, -0.02, 1.2), (0.045, 0.96, 1.25), mats["black"], root, 0.025)
    cube("temper_v3_door_lower_cutout_left", (-1.61, -0.32, 0.48), (0.052, 0.11, 0.3), mats["dark_inner"], root, 0.004)
    cube("temper_v3_door_lower_cutout_right", (-1.61, 0.32, 0.48), (0.052, 0.11, 0.3), mats["dark_inner"], root, 0.004)
    for y in [-0.63, 0.63]:
        cyl_between(f"temper_v3_polished_door_guide_{y}", (-1.62, y, 0.42), (-1.62, y, 2.08), 0.028, mats["stainless"], root, 14)
        for i in range(11):
            cube(f"temper_v3_guide_tooth_{y}_{i:02d}", (-1.64, y, 0.52 + i * 0.14), (0.03, 0.07, 0.018), mats["stainless"], root, 0.002)
    add_handle("temper_v3_door_pull_left", root, mats, (-1.64, -0.42, 0.84), (-1.64, -0.42, 1.34), 0.012, 0.04)
    add_handle("temper_v3_door_pull_right", root, mats, (-1.64, 0.42, 0.84), (-1.64, 0.42, 1.34), 0.012, 0.04)
    add_micro_bolts("temper_v3_front_black_column_left", root, mats, [(-1.54, -0.69, z) for z in [0.55, 0.82, 1.09, 1.36, 1.63, 1.9]], 0.014, "x")
    add_micro_bolts("temper_v3_front_black_column_right", root, mats, [(-1.54, 0.69, z) for z in [0.55, 0.82, 1.09, 1.36, 1.63, 1.9]], 0.014, "x")

    # Hood and brand plate.
    add_nameplate("temper_v3_big_brand_plate", root, mats, (-1.16, -0.89, 2.56), "KINGKIND", (0.62, 0.022, 0.18), 0.065)
    cube("temper_v3_hood_lower_lip", (-1.06, -0.86, 2.17), (1.22, 0.08, 0.09), mats["dark_inner"], root, 0.01)
    for i, x in enumerate([-1.12, -0.8, -0.48, -0.16, 0.16], start=1):
        cube(f"temper_v3_hood_bottom_bolt_{i:02d}", (x, -0.91, 2.15), (0.028, 0.018, 0.028), mats["bolt"], root, 0.003)

    # Side service doors, warnings, ribs.
    for idx, x in enumerate([-0.2, 0.38, 0.96], start=1):
        add_panel_door(f"temper_v3_side_service_door_{idx:02d}", root, mats, (x, 0, 1.16), (0.44, 0.022, 1.05), 0.765, "right")
    add_nameplate("temper_v3_side_spec_plate", root, mats, (0.42, -0.705, 0.84), "SPEC", (0.28, 0.018, 0.12), 0.035)
    add_perforated_panel("temper_v3_blower_guard", root, mats, (0.24), (0.82), 1.42, 1.82, -0.875, 4, 6)
    add_cable_chain("temper_v3_lift_chain_left", root, mats, (-1.58, -0.55, 0.48), (-1.58, -0.55, 1.98), 16, 0.008)
    add_cable_chain("temper_v3_lift_chain_right", root, mats, (-1.58, 0.55, 0.48), (-1.58, 0.55, 1.98), 16, 0.008)

    # Better platform and ladder.
    for i in range(7):
        cube(f"temper_v3_platform_anti_slip_{i+1:02d}", (0.62 + i * 0.13, 0.95, 2.19), (0.025, 0.7, 0.016), mats["dirty_edge"], root, 0.002)
    cyl_between("temper_v3_platform_underbrace_a", (0.55, 0.58, 2.05), (1.52, 1.34, 1.36), 0.018, mats["rail_yellow"], root, 10)
    cyl_between("temper_v3_platform_underbrace_b", (0.55, 1.34, 2.05), (1.52, 0.58, 1.36), 0.018, mats["rail_yellow"], root, 10)
    add_cable_chain("temper_v3_motor_cable", root, mats, (-1.34, -0.86, 1.98), (-1.48, -0.72, 0.5), 10, 0.01)
    return root


def add_washing_v3_details(root, mats):
    root.name = "photo_washing_machine_v3_root"
    root["model_id"] = "photo_washing_machine_v3"
    root["model_label"] = "实拍参考-清洗机 V3"
    root["detail_level"] = "v3_refined_showcase"

    # Tank lids and hinged covers.
    for idx, x in enumerate([0.0, 0.88], start=1):
        add_hinge(f"wash_v3_lid_hinge_{idx:02d}_a", root, mats, x - 0.22, -0.38 if idx == 1 else 0.38, 2.25, 0.22, "x")
        add_hinge(f"wash_v3_lid_hinge_{idx:02d}_b", root, mats, x + 0.22, -0.38 if idx == 1 else 0.38, 2.25, 0.22, "x")
        add_handle(f"wash_v3_lid_handle_{idx:02d}", root, mats, (x - 0.16, -0.38 if idx == 1 else 0.38, 2.34), (x + 0.16, -0.38 if idx == 1 else 0.38, 2.34), 0.012, 0.05)

    # Cabinet and tank details.
    add_panel_door("wash_v3_control_cabinet_upper", root, mats, (-1.85, 0, 1.32), (0.44, 0.024, 0.48), -0.968, "left")
    add_panel_door("wash_v3_control_cabinet_lower", root, mats, (-1.85, 0, 0.66), (0.48, 0.024, 0.58), -0.968, "left")
    add_perforated_panel("wash_v3_control_cabinet_filter", root, mats, -2.02, -1.68, 0.44, 0.74, -0.99, 5, 7)
    add_nameplate("wash_v3_control_brand_plate", root, mats, (-1.85, -0.99, 1.74), "KINGKIND", (0.36, 0.018, 0.1), 0.04)
    add_micro_bolts("wash_v3_tank_corner_bolts", root, mats, [
        (-1.08, -0.72, 0.34), (1.78, -0.72, 0.34), (-1.08, -0.72, 1.14), (1.78, -0.72, 1.14),
        (-0.48, -0.64, 1.18), (1.76, -0.64, 1.18), (-0.48, -0.64, 2.08), (1.76, -0.64, 2.08),
    ], 0.012, "y")

    # Dense green pipe network with flanges, clamps, pressure gauges.
    main_segments = [
        [(-1.3, -1.02, 0.56), (1.55, -1.02, 0.56)],
        [(-0.85, -1.02, 1.62), (1.24, -1.02, 1.62)],
        [(-0.05, -1.02, 1.9), (0.95, -1.02, 1.9)],
    ]
    for idx, seg in enumerate(main_segments, start=1):
        add_pipe_clamps(f"wash_v3_green_pipe_{idx:02d}", root, mats, seg, 0.28, 0.045)
    for idx, x in enumerate([-0.95, -0.45, 0.05, 0.55, 1.05, 1.48], start=1):
        cyl(f"wash_v3_green_pipe_flange_{idx:02d}_a", (x, -1.02, 0.56), 0.065, 0.018, mats["brass"], root, 16, "x")
        cyl(f"wash_v3_green_pipe_flange_{idx:02d}_b", (x, -1.02, 1.62), 0.06, 0.018, mats["brass"], root, 16, "x")
    for idx, x in enumerate([-0.72, 0.18, 1.08], start=1):
        add_pressure_gauge_face(f"wash_v3_pressure_gauge_{idx:02d}", root, mats, (x, -1.06, 1.28), 0.062)

    # Pumps: couplings, bases, feet, cable tubes.
    pump_locs = [(-1.1, -0.98, 0.34), (-0.28, -0.98, 0.34), (0.55, -0.98, 0.34), (1.34, -0.98, 0.34)]
    for idx, loc in enumerate(pump_locs, start=1):
        cyl(f"wash_v3_pump_coupling_{idx:02d}", (loc[0] + 0.25, loc[1], loc[2]), 0.058, 0.12, mats["stainless"], root, 16, "x")
        cube(f"wash_v3_pump_terminal_box_{idx:02d}", (loc[0] - 0.08, loc[1] - 0.18, loc[2] + 0.16), (0.13, 0.07, 0.08), mats["motor_blue"], root, 0.006)
        add_cable_chain(f"wash_v3_pump_cable_chain_{idx:02d}", root, mats, (loc[0] - 0.08, loc[1] - 0.2, loc[2] + 0.16), (loc[0] - 0.24, -1.17, 0.18), 5, 0.008)
    for i in range(8):
        cube(f"wash_v3_platform_anti_slip_{i+1:02d}", (-1.18 + i * 0.34, 0.83, 2.45), (0.035, 0.55, 0.018), mats["dirty_edge"], root, 0.002)
    return root


def add_cart_v3_details(root, mats):
    root.name = "photo_transfer_cart_v3_root"
    root["model_id"] = "photo_transfer_cart_v3"
    root["model_label"] = "实拍参考-料车/取料小车 V3"
    root["detail_level"] = "v3_refined_showcase"

    # Roller bed mechanism.
    for idx, x in enumerate([-0.35, -0.05, 0.25, 0.55, 0.85], start=1):
        cyl(f"cart_v3_roller_bearing_left_{idx:02d}", (x, -0.58, 0.84), 0.065, 0.035, mats["stainless"], root, 18, "y")
        cyl(f"cart_v3_roller_bearing_right_{idx:02d}", (x, 0.58, 0.84), 0.065, 0.035, mats["stainless"], root, 18, "y")
        add_micro_bolts(f"cart_v3_roller_bearing_bolts_left_{idx:02d}", root, mats, [(x - 0.035, -0.606, 0.875), (x + 0.035, -0.606, 0.875)], 0.009, "y")
        add_micro_bolts(f"cart_v3_roller_bearing_bolts_right_{idx:02d}", root, mats, [(x - 0.035, 0.606, 0.875), (x + 0.035, 0.606, 0.875)], 0.009, "y")
    for i in range(9):
        cube(f"cart_v3_cross_guard_flatbar_{i+1:02d}", (-0.48 + i * 0.2, 0, 1.01), (0.018, 1.1, 0.018), mats["rail_yellow"], root, 0.002)

    # Drive side, chain and motor wiring.
    cube("cart_v3_drive_chain_cover_lid", (0.96, 0.73, 0.52), (0.72, 0.06, 0.18), mats["rubber_gray"], root, 0.012)
    for i in range(11):
        cube(f"cart_v3_visible_chain_link_{i+1:02d}", (0.56 + i * 0.065, 0.765, 0.58), (0.042, 0.018, 0.026), mats["stainless"], root, 0.002)
    add_cable_chain("cart_v3_main_drag_chain", root, mats, (1.36, 0.55, 0.62), (-0.62, 0.76, 0.36), 18, 0.012)

    # Guard rail plates and small operator panel.
    for x in [-1.18, -0.48, 0.32, 1.18]:
        for y in [-0.8, 0.8]:
            cube(f"cart_v3_guard_post_weld_plate_{x:.1f}_{y:.1f}", (x, y, 0.292), (0.13, 0.13, 0.018), mats["rail_yellow"], root, 0.004)
    cube("cart_v3_small_operator_box", (-1.12, -0.86, 0.96), (0.18, 0.08, 0.28), mats["panel_white"], root, 0.01)
    sphere("cart_v3_operator_button_green", (-1.12, -0.905, 1.02), 0.026, mats["green_lamp"], root, 12)
    sphere("cart_v3_operator_button_red", (-1.12, -0.905, 0.93), 0.026, mats["red"], root, 12)
    add_panel_door("cart_v3_front_electrical_box", root, mats, (-0.72, 0, 0.72), (0.72, 0.02, 0.7), -0.655, "left")
    add_nameplate("cart_v3_cart_id_plate", root, mats, (-0.72, -0.672, 1.05), "CART", (0.26, 0.016, 0.08), 0.034)

    # Track and wheel detail.
    for x in [-1.05, -0.25, 0.55, 1.15]:
        for y in [-0.72, 0.72]:
            cyl(f"cart_v3_wheel_outer_flange_{x:.1f}_{y:.1f}", (x, y, 0.02), 0.126, 0.018, mats["stainless"], root, 18, "y")
            cyl(f"cart_v3_wheel_inner_flange_{x:.1f}_{y:.1f}", (x, y, 0.02), 0.104, 0.014, mats["rubber_gray"], root, 18, "y")
    for i in range(8):
        x = -1.35 + i * 0.4
        cube(f"cart_v3_track_sleepers_{i+1:02d}", (x, -0.78, -0.08), (0.08, 0.32, 0.035), mats["dirty_edge"], root, 0.004)
        cube(f"cart_v3_track_sleepers_b_{i+1:02d}", (x, 0.78, -0.08), (0.08, 0.32, 0.035), mats["dirty_edge"], root, 0.004)
    return root


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def render_preview_v3(scene, cam, roots, root, file_path):
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
        offset = Vector((-size * 1.45, -size * 0.85, size * 0.76))
        lens = 45
    elif "washing" in model_id:
        offset = Vector((size * 1.0, -size * 1.55, size * 0.92))
        lens = 42
    elif "cart" in model_id:
        offset = Vector((size * 1.15, -size * 1.35, size * 0.86))
        lens = 44
    else:
        offset = Vector((size * 1.18, -size * 1.45, size * 0.88))
        lens = 42
    cam.location = center + offset
    look_at(cam, center + Vector((0, 0, size * 0.05)))
    cam.data.lens = lens
    scene.render.filepath = str(file_path)
    bpy.ops.render.render(write_still=True)
    for item in roots:
        item.location = old_locations[item.name]
        for obj in all_children(item):
            obj.hide_render = False
            obj.hide_viewport = False
    bpy.context.view_layer.update()


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    scene = base.new_scene()
    mats = make_v3_materials()
    cam = base.setup_lighting(scene)
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 980
    cube("photo_v3_factory_floor", (0, 0, -0.08), (10.8, 5.0, 0.08), mats["dark_gray"], None, 0)

    roots = []
    multi = add_multipurpose_v3_details(v2.detail_multipurpose(base.build_multipurpose_furnace(mats), mats), mats)
    temper = add_tempering_v3_details(v2.detail_tempering(base.build_tempering_furnace(mats), mats), mats)
    wash = add_washing_v3_details(v2.detail_washing(base.build_washing_machine(mats), mats), mats)
    cart = add_cart_v3_details(v2.detail_cart(base.build_transfer_cart(mats), mats), mats)
    roots.extend([multi, temper, wash, cart])

    overview_positions = {
        "photo_multipurpose_furnace_v3": (-2.65, -0.85, 0),
        "photo_tempering_furnace_v3": (2.15, -0.85, 0),
        "photo_washing_machine_v3": (-2.4, 1.48, 0),
        "photo_transfer_cart_v3": (2.24, 1.48, 0),
    }
    outputs = {}
    for root in roots:
        root.location = overview_positions[root["model_id"]]

    for root in roots:
        model_id = root["model_id"]
        glb_path = OUTPUT_DIR / f"{model_id}.glb"
        preview_path = OUTPUT_DIR / f"{model_id}_preview.png"
        base.export_glb(root, glb_path)
        render_preview_v3(scene, cam, roots, root, preview_path)
        outputs[model_id] = {
            "glb": str(glb_path),
            "preview": str(preview_path),
            "object_count": len(all_children(root)),
            "mesh_count": sum(1 for obj in all_children(root) if obj.type == "MESH"),
        }

    overview_path = OUTPUT_DIR / "photo_equipment_models_v3_overview.png"
    base.render_overview(scene, cam, roots, overview_path)
    blend_path = OUTPUT_DIR / "photo_equipment_models_v3.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    outputs["_overview"] = str(overview_path)
    outputs["_blend"] = str(blend_path)
    print("PHOTO_EQUIPMENT_MODEL_V3_OUTPUTS=" + repr(outputs))
    return outputs


if __name__ == "__main__":
    main()
