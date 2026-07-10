const { getDb } = require('../backend/db/database');
const { stringifyModelMetadata } = require('../backend/services/modelAssetMetadata');

const DEVICE_IDS = ['Furnace_01', 'Furnace_02', 'Furnace_03', 'Furnace_04', 'Furnace_05', '6# 多用炉', '7# 多用炉'];
const MODEL_ID = 'photo_multipurpose_furnace_v4';

function baseByte(index) {
  return 30 + index * 20;
}

function animationPoints(deviceId, index) {
  const base = baseByte(index);
  const boolPoint = (name, label, bit, category = 'motors') => ({
    device_id: deviceId,
    name,
    label,
    plc_tag: `DB1.DBX${base}.${bit}`,
    data_type: 'BOOL',
    category,
    value_role: name,
    quality: 'good',
    scale: 1,
    offset: 0,
    expression: '',
    display_format: '',
    unit: '',
    sample_interval_ms: 500,
    access_type: 'READ',
    db_number: null,
    db_byte_offset: null,
    bit_offset: null,
    point_kind: 'normal',
    alarm_record_role: '',
    alarm_text: '',
    alarm_level: 'WARNING',
    alarm_condition: '=1',
    alarm_high: null,
    alarm_low: null
  });
  const wordPoint = (name, label, byteOffset) => ({
    device_id: deviceId,
    name,
    label,
    plc_tag: `DB1.DBW${base + byteOffset}`,
    data_type: 'WORD',
    category: 'motors',
    value_role: name,
    quality: 'good',
    scale: 1,
    offset: 0,
    expression: '',
    display_format: '0',
    unit: 'rpm',
    sample_interval_ms: 500,
    access_type: 'READ',
    db_number: null,
    db_byte_offset: null,
    bit_offset: null,
    point_kind: 'normal',
    alarm_record_role: '',
    alarm_text: '',
    alarm_level: 'WARNING',
    alarm_condition: '=1',
    alarm_high: null,
    alarm_low: null
  });

  return [
    boolPoint('front_door_open', '前门开到位', 0, 'doors'),
    boolPoint('middle_door_open', '中门开到位', 1, 'doors'),
    boolPoint('rear_fan', '后室风扇运行', 2),
    boolPoint('front_fan', '前室风扇运行', 3),
    boolPoint('oil_stir_1', '油搅拌1运行', 4),
    boolPoint('oil_stir_2', '油搅拌2运行', 5),
    boolPoint('oil_stir_3', '油搅拌3运行', 6),
    boolPoint('oil_stir_4', '油搅拌4运行', 7),
    wordPoint('rear_fan_speed', '后室风扇转速', 2),
    wordPoint('front_fan_speed', '前室风扇转速', 4),
    wordPoint('oil_stir_1_speed', '油搅拌1转速', 6),
    wordPoint('oil_stir_2_speed', '油搅拌2转速', 8),
    wordPoint('oil_stir_3_speed', '油搅拌3转速', 10),
    wordPoint('oil_stir_4_speed', '油搅拌4转速', 12)
  ];
}

function doorBindings(nodeNames, sourceKey, name, outputMax) {
  return nodeNames.map((nodeName, index) => ({
    id: `${sourceKey}_${index + 1}`,
    name,
    node_name: nodeName,
    source_group: 'doors',
    source_key: sourceKey,
    action: 'translate',
    axis: 'y',
    input_min: 0,
    input_max: 1,
    output_min: 0,
    output_max: outputMax,
    speed_factor: 0.10472,
    on_color: '#00ff88',
    off_color: '#666666',
    invert: false
  }));
}

function rotateBinding(id, name, nodeName, sourceKey, axis = 'z', sourceGroup = 'motors') {
  return {
    id,
    name,
    node_name: nodeName,
    source_group: sourceGroup,
    source_key: sourceKey,
    action: 'rotate_speed',
    axis,
    input_min: 0,
    input_max: 100,
    output_min: 0,
    output_max: 90,
    speed_factor: 0.10472,
    on_color: '#00ff88',
    off_color: '#666666',
    invert: false
  };
}

function makePartBindings() {
  return [
    ...doorBindings([
      'multi_front_heat_door_black_panel',
      'multi_v2_front_door_inner_glow_panel',
      'multi_v3_front_door_refractory_inner',
      'multi_v4_front_flat_black_inner_door',
      'multi_v2_black_door_handle',
      'multi_v3_front_door_handle_bar',
      'multi_v3_front_door_handle_mount_a',
      'multi_v3_front_door_handle_mount_b'
    ], 'front_door_open', '前门开关升降', 0.78),
    ...doorBindings([
      'multi_middle_door_reference'
    ], 'middle_door_open', '中门开关升降', 0.62),
    rotateBinding('rear_fan_rotate', '后室风扇旋转', 'multi_v4_roof_circulation_fan_01', 'rear_fan_speed', 'z'),
    rotateBinding('front_fan_rotate', '前室风扇旋转', 'multi_v4_roof_circulation_fan_02', 'front_fan_speed', 'z'),
    rotateBinding('oil_stir_1_rotate', '油搅拌1旋转', 'multi_v4_oil_agitator_shaft_01', 'oil_stir_1_speed', 'z'),
    rotateBinding('oil_stir_2_rotate', '油搅拌2旋转', 'multi_v4_oil_agitator_shaft_02', 'oil_stir_2_speed', 'z'),
    rotateBinding('oil_stir_3_rotate', '油搅拌3旋转', 'multi_v4_oil_agitator_shaft_03', 'oil_stir_3_speed', 'z'),
    rotateBinding('oil_stir_4_rotate', '油搅拌4旋转', 'multi_v4_oil_agitator_shaft_04', 'oil_stir_4_speed', 'z')
  ];
}

async function upsertPoint(db, point) {
  const existing = await db.get('SELECT id FROM data_points WHERE device_id = ? AND value_role = ? ORDER BY id ASC LIMIT 1', [point.device_id, point.value_role]);
  if (existing) {
    await db.run(`UPDATE data_points SET
      name=?, label=?, plc_tag=?, data_type=?, category=?, value_role=?, quality=?,
      scale=?, offset=?, expression=?, display_format=?, unit=?, sample_interval_ms=?,
      access_type=?, db_number=?, db_byte_offset=?, bit_offset=?, point_kind=?,
      alarm_record_role=?, alarm_text=?, alarm_level=?, alarm_condition=?, alarm_high=?, alarm_low=?
      WHERE id=?`, [
      point.name, point.label, point.plc_tag, point.data_type, point.category, point.value_role, point.quality,
      point.scale, point.offset, point.expression, point.display_format, point.unit, point.sample_interval_ms,
      point.access_type, point.db_number, point.db_byte_offset, point.bit_offset, point.point_kind,
      point.alarm_record_role, point.alarm_text, point.alarm_level, point.alarm_condition, point.alarm_high, point.alarm_low,
      existing.id
    ]);
    return 'updated';
  }
  await db.run(`INSERT INTO data_points (
    device_id, name, label, plc_tag, data_type, category, value_role, quality,
    scale, offset, expression, display_format, unit, sample_interval_ms,
    access_type, db_number, db_byte_offset, bit_offset, point_kind,
    alarm_record_role, alarm_text, alarm_level, alarm_condition, alarm_high, alarm_low
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    point.device_id, point.name, point.label, point.plc_tag, point.data_type, point.category, point.value_role, point.quality,
    point.scale, point.offset, point.expression, point.display_format, point.unit, point.sample_interval_ms,
    point.access_type, point.db_number, point.db_byte_offset, point.bit_offset, point.point_kind,
    point.alarm_record_role, point.alarm_text, point.alarm_level, point.alarm_condition, point.alarm_high, point.alarm_low
  ]);
  return 'inserted';
}

async function main() {
  const db = await getDb();
  const model = await db.get('SELECT * FROM models WHERE id = ?', [MODEL_ID]);
  if (!model) throw new Error(`模型不存在: ${MODEL_ID}`);
  const currentMetadata = typeof model.metadata === 'string' ? JSON.parse(model.metadata || '{}') : (model.metadata || {});
  const nextMetadata = {
    ...currentMetadata,
    batchable: false,
    partBindings: makePartBindings(),
    runtime: {
      ...(currentMetadata.runtime || {}),
      enableGenericBindings: true,
      animationProfile: 'multipurpose_furnace_minimum_v1'
    }
  };
  await db.run('UPDATE models SET metadata = ? WHERE id = ?', [stringifyModelMetadata(nextMetadata, { name: model.name }), MODEL_ID]);

  const summary = [];
  for (let index = 0; index < DEVICE_IDS.length; index += 1) {
    const deviceId = DEVICE_IDS[index];
    const device = await db.get('SELECT id, name FROM devices WHERE id = ?', [deviceId]);
    if (!device) {
      summary.push({ deviceId, skipped: 'missing_device' });
      continue;
    }
    await db.run(`UPDATE devices SET
      plc_enabled=1, plc_protocol='S7', plc_ip='127.0.0.1', plc_port=1102,
      plc_rack=0, plc_slot=1, plc_timeout=3000, plc_retry_interval=2000, plc_max_retries=0
      WHERE id=?`, [deviceId]);

    let inserted = 0;
    let updated = 0;
    for (const point of animationPoints(deviceId, index)) {
      const result = await upsertPoint(db, point);
      if (result === 'inserted') inserted += 1;
      else updated += 1;
    }
    summary.push({ deviceId, baseByte: baseByte(index), inserted, updated });
  }

  console.log(JSON.stringify({ model: MODEL_ID, partBindings: nextMetadata.partBindings.length, devices: summary }, null, 2));
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
