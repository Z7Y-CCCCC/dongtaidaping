using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Backend
{
    public sealed class FactoryConfigDto
    {
        [JsonProperty("settings")]
        public Dictionary<string, string> Settings { get; set; } = new Dictionary<string, string>();

        [JsonProperty("workshops")]
        public List<WorkshopDto> Workshops { get; set; } = new List<WorkshopDto>();

        [JsonProperty("models")]
        public List<ModelAssetDto> Models { get; set; } = new List<ModelAssetDto>();

        [JsonProperty("platform")]
        public JObject Platform { get; set; } = new JObject();
    }

    public sealed class WorkshopDto
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("name")] public string Name { get; set; }
        [JsonProperty("layout_json")] public JToken Layout { get; set; }
        [JsonProperty("lines")] public List<LineDto> Lines { get; set; } = new List<LineDto>();
        [JsonProperty("devices")] public List<DeviceDto> Devices { get; set; } = new List<DeviceDto>();

        public JObject LayoutObject => JsonObject(Layout);

        private static JObject JsonObject(JToken token)
        {
            if (token is JObject value) return value;
            if (token?.Type == JTokenType.String)
            {
                try { return JObject.Parse(token.Value<string>() ?? "{}"); }
                catch { return new JObject(); }
            }
            return new JObject();
        }
    }

    public sealed class LineDto
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("name")] public string Name { get; set; }
        [JsonProperty("workshop_id")] public string WorkshopId { get; set; }
        [JsonProperty("layout_json")] public JToken Layout { get; set; }
        [JsonProperty("devices")] public List<DeviceDto> Devices { get; set; } = new List<DeviceDto>();

        public JObject LayoutObject => JsonObject(Layout);

        private static JObject JsonObject(JToken token)
        {
            if (token is JObject value) return value;
            if (token?.Type == JTokenType.String)
            {
                try { return JObject.Parse(token.Value<string>() ?? "{}"); }
                catch { return new JObject(); }
            }
            return new JObject();
        }
    }

    public sealed class DeviceDto
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("name")] public string Name { get; set; }
        [JsonProperty("line_id")] public string LineId { get; set; }
        [JsonProperty("model_type")] public string ModelType { get; set; }
        [JsonProperty("pos_x")] public float PositionX { get; set; }
        [JsonProperty("pos_y")] public float PositionY { get; set; }
        [JsonProperty("pos_z")] public float PositionZ { get; set; }
        [JsonProperty("rotation_y")] public float RotationY { get; set; }
        [JsonProperty("scale")] public float Scale { get; set; } = 1f;
        [JsonProperty("coordinate_space")] public string CoordinateSpace { get; set; } = "line_local";
        [JsonProperty("instance_config")] public JToken InstanceConfig { get; set; }
        [JsonProperty("dataPoints")] public List<DataPointDto> DataPoints { get; set; } = new List<DataPointDto>();

        public JObject InstanceConfigObject
        {
            get
            {
                if (InstanceConfig is JObject value) return value;
                if (InstanceConfig?.Type == JTokenType.String)
                {
                    try { return JObject.Parse(InstanceConfig.Value<string>() ?? "{}"); }
                    catch { return new JObject(); }
                }
                return new JObject();
            }
        }
    }

    public sealed class DataPointDto
    {
        [JsonProperty("id")] public long Id { get; set; }
        [JsonProperty("device_id")] public string DeviceId { get; set; }
        [JsonProperty("name")] public string Name { get; set; }
        [JsonProperty("label")] public string Label { get; set; }
        [JsonProperty("plc_tag")] public string PlcTag { get; set; }
        [JsonProperty("data_type")] public string DataType { get; set; }
        [JsonProperty("category")] public string Category { get; set; }
        [JsonProperty("value_role")] public string ValueRole { get; set; }
        [JsonProperty("unit")] public string Unit { get; set; }
        [JsonProperty("display_format")] public string DisplayFormat { get; set; }
        [JsonProperty("point_kind")] public string PointKind { get; set; }
        [JsonProperty("alarm_text")] public string AlarmText { get; set; }
        [JsonProperty("alarm_level")] public string AlarmLevel { get; set; }
    }

    public sealed class ModelAssetDto
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("name")] public string Name { get; set; }
        [JsonProperty("file_path")] public string FilePath { get; set; }
        [JsonProperty("default_scale")] public float DefaultScale { get; set; } = 1f;
        [JsonProperty("metadata")] public JToken Metadata { get; set; }

        public JObject MetadataObject
        {
            get
            {
                if (Metadata is JObject value) return value;
                if (Metadata?.Type == JTokenType.String)
                {
                    try { return JObject.Parse(Metadata.Value<string>() ?? "{}"); }
                    catch { return new JObject(); }
                }
                return new JObject();
            }
        }
    }

    public sealed class PartBindingDto
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("name")] public string Name { get; set; }
        [JsonProperty("node_path")] public string NodePath { get; set; }
        [JsonProperty("node_name")] public string NodeName { get; set; }
        [JsonProperty("source_group")] public string SourceGroup { get; set; }
        [JsonProperty("source_key")] public string SourceKey { get; set; }
        [JsonProperty("action")] public string Action { get; set; }
        [JsonProperty("axis")] public string Axis { get; set; } = "y";
        [JsonProperty("input_min")] public float InputMin { get; set; }
        [JsonProperty("input_max")] public float InputMax { get; set; } = 100f;
        [JsonProperty("output_min")] public float OutputMin { get; set; }
        [JsonProperty("output_max")] public float OutputMax { get; set; } = 90f;
        [JsonProperty("speed_factor")] public float SpeedFactor { get; set; } = 0.10472f;
        [JsonProperty("on_color")] public string OnColor { get; set; } = "#00ff88";
        [JsonProperty("off_color")] public string OffColor { get; set; } = "#666666";
        [JsonProperty("invert")] public bool Invert { get; set; }
    }
}
