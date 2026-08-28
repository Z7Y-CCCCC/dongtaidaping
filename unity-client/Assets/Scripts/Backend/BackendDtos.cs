using System;
using System.Collections.Generic;
using System.Linq;
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

    /// <summary>
    /// Configuration shared by the admin model library, the Unity native
    /// presenter and the transparent dashboard overlay.  The JSON is kept
    /// intentionally small so a model can carry a sensible default while a
    /// device instance may override only the fields it needs.
    /// </summary>
    public sealed class DeviceInspectionCameraDto
    {
        [JsonProperty("yaw")] public float Yaw { get; set; } = 238f;
        [JsonProperty("pitch")] public float Pitch { get; set; } = 19f;
        [JsonProperty("distance_scale")] public float DistanceScale { get; set; } = 1.12f;
        [JsonProperty("target_offset")] public List<float> TargetOffset { get; set; } = new List<float> { 0f, 0f, 0f };

        public void Normalize(float fallbackYaw, float fallbackPitch, float fallbackDistance)
        {
            if (!float.IsFinite(Yaw)) Yaw = fallbackYaw;
            if (!float.IsFinite(Pitch)) Pitch = fallbackPitch;
            if (!float.IsFinite(DistanceScale) || DistanceScale <= 0f) DistanceScale = fallbackDistance;
            Yaw = Math.Max(-360f, Math.Min(360f, Yaw));
            Pitch = Math.Max(6f, Math.Min(82f, Pitch));
            DistanceScale = Math.Max(.1f, Math.Min(10f, DistanceScale));
            TargetOffset = NormalizeVector(TargetOffset);
        }

        public static List<float> NormalizeVector(IEnumerable<float> values)
        {
            var result = (values ?? Enumerable.Empty<float>()).Take(3).ToList();
            while (result.Count < 3) result.Add(0f);
            return result.Select(value => float.IsFinite(value) ? Math.Max(-10000f, Math.Min(10000f, value)) : 0f).ToList();
        }
    }

    public sealed class DeviceInspectionStageDto
    {
        [JsonProperty("view_id")] public string ViewId { get; set; } = string.Empty;
        [JsonProperty("camera")] public DeviceInspectionCameraDto Camera { get; set; } = new DeviceInspectionCameraDto();
        [JsonProperty("transition_seconds")] public float TransitionSeconds { get; set; } = .65f;

        public void Normalize(float fallbackYaw, float fallbackPitch, float fallbackDistance)
        {
            Camera ??= new DeviceInspectionCameraDto();
            Camera.Normalize(fallbackYaw, fallbackPitch, fallbackDistance);
            if (!float.IsFinite(TransitionSeconds)) TransitionSeconds = .65f;
            TransitionSeconds = Math.Max(0f, Math.Min(10f, TransitionSeconds));
            ViewId ??= string.Empty;
        }
    }

    public sealed class DeviceInspectionShellDto
    {
        [JsonProperty("node_paths")] public List<string> NodePaths { get; set; } = new List<string>();
        [JsonProperty("node_names")] public List<string> NodeNames { get; set; } = new List<string>();
        [JsonProperty("opacity")] public float Opacity { get; set; } = .18f;
        [JsonProperty("wireframe")] public bool Wireframe { get; set; }

        public void Normalize()
        {
            NodePaths = NormalizeStrings(NodePaths);
            NodeNames = NormalizeStrings(NodeNames);
            Opacity = Math.Max(.03f, Math.Min(.95f, float.IsFinite(Opacity) ? Opacity : .18f));
        }

        private static List<string> NormalizeStrings(IEnumerable<string> values)
        {
            return (values ?? Enumerable.Empty<string>())
                .Select(value => (value ?? string.Empty).Trim())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(100)
                .ToList();
        }
    }

    public sealed class DeviceInspectionPartDto
    {
        [JsonProperty("id")] public string Id { get; set; } = string.Empty;
        [JsonProperty("name")] public string Name { get; set; } = string.Empty;
        [JsonProperty("node_path")] public string NodePath { get; set; } = string.Empty;
        [JsonProperty("node_name")] public string NodeName { get; set; } = string.Empty;
        [JsonProperty("explode_offset")] public List<float> ExplodeOffset { get; set; } = new List<float> { 0f, 0f, 0f };
        [JsonProperty("label_offset")] public List<float> LabelOffset { get; set; } = new List<float> { 0f, .35f, 0f };
        [JsonProperty("description")] public string Description { get; set; } = string.Empty;
        [JsonProperty("point_ids")] public List<string> PointIds { get; set; } = new List<string>();
        [JsonProperty("point_keys")] public List<string> PointKeys { get; set; } = new List<string>();
        [JsonProperty("detail_view_id")] public string DetailViewId { get; set; } = string.Empty;

        public void Normalize(int index)
        {
            Id = string.IsNullOrWhiteSpace(Id) ? $"part_{index + 1}" : Id.Trim();
            Name = string.IsNullOrWhiteSpace(Name) ? (NodeName ?? Id) : Name.Trim();
            NodePath = (NodePath ?? string.Empty).Trim();
            NodeName = (NodeName ?? string.Empty).Trim();
            ExplodeOffset = DeviceInspectionCameraDto.NormalizeVector(ExplodeOffset);
            LabelOffset = DeviceInspectionCameraDto.NormalizeVector(LabelOffset);
            Description ??= string.Empty;
            DetailViewId ??= string.Empty;
            PointIds = NormalizeStrings(PointIds);
            PointKeys = NormalizeStrings(PointKeys);
        }

        private static List<string> NormalizeStrings(IEnumerable<string> values)
        {
            return (values ?? Enumerable.Empty<string>())
                .Select(value => (value ?? string.Empty).Trim())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(64)
                .ToList();
        }
    }

    public sealed class DeviceInspectionConfigDto
    {
        [JsonProperty("enabled")] public bool Enabled { get; set; } = true;
        [JsonProperty("shell")] public DeviceInspectionShellDto Shell { get; set; } = new DeviceInspectionShellDto();
        [JsonProperty("solid")] public DeviceInspectionStageDto Solid { get; set; } = new DeviceInspectionStageDto();
        [JsonProperty("xray")] public DeviceInspectionStageDto Xray { get; set; } = new DeviceInspectionStageDto
        {
            Camera = new DeviceInspectionCameraDto { Yaw = 238f, Pitch = 19f, DistanceScale = 1.08f }
        };
        [JsonProperty("exploded")] public DeviceInspectionStageDto Exploded { get; set; } = new DeviceInspectionStageDto
        {
            Camera = new DeviceInspectionCameraDto { Yaw = 238f, Pitch = 22f, DistanceScale = 1.22f }
        };
        [JsonProperty("animation_duration")] public float AnimationDuration { get; set; } = .65f;
        [JsonProperty("parts")] public List<DeviceInspectionPartDto> Parts { get; set; } = new List<DeviceInspectionPartDto>();

        public void Normalize()
        {
            Shell ??= new DeviceInspectionShellDto();
            Shell.Normalize();
            Solid ??= new DeviceInspectionStageDto();
            Xray ??= new DeviceInspectionStageDto();
            Exploded ??= new DeviceInspectionStageDto();
            Solid.Normalize(238f, 19f, 1.12f);
            Xray.Normalize(238f, 19f, 1.08f);
            Exploded.Normalize(238f, 22f, 1.22f);
            AnimationDuration = Math.Max(.05f, Math.Min(5f, float.IsFinite(AnimationDuration) ? AnimationDuration : .65f));
            Parts ??= new List<DeviceInspectionPartDto>();
            Parts = Parts.Take(64).ToList();
            for (var index = 0; index < Parts.Count; index += 1) Parts[index]?.Normalize(index);
        }
    }

    public static class InspectionConfigResolver
    {
        public static DeviceInspectionConfigDto Resolve(ModelAssetDto asset, DeviceDto device)
        {
            var source = asset?.MetadataObject?["inspection"] as JObject ?? new JObject();
            var overrideToken = device?.InstanceConfigObject?["inspection"] as JObject;
            var merged = (JObject)source.DeepClone();
            if (overrideToken != null)
            {
                merged.Merge(overrideToken, new JsonMergeSettings
                {
                    MergeArrayHandling = MergeArrayHandling.Replace,
                    MergeNullValueHandling = MergeNullValueHandling.Ignore
                });
            }

            DeviceInspectionConfigDto result;
            try { result = merged.ToObject<DeviceInspectionConfigDto>() ?? new DeviceInspectionConfigDto(); }
            catch { result = new DeviceInspectionConfigDto(); }

            result.Normalize();
            if (result.Parts.Count == 0)
            {
                result.Parts = FallbackParts(asset?.MetadataObject);
                for (var index = 0; index < result.Parts.Count; index += 1) result.Parts[index].Normalize(index);
            }
            return result;
        }

        private static List<DeviceInspectionPartDto> FallbackParts(JObject metadata)
        {
            var result = new List<DeviceInspectionPartDto>();
            foreach (var binding in metadata?["partBindings"]?.OfType<JObject>() ?? Enumerable.Empty<JObject>())
            {
                var nodeName = binding.Value<string>("node_name") ?? binding.Value<string>("nodeName") ?? string.Empty;
                var nodePath = binding.Value<string>("node_path") ?? binding.Value<string>("nodePath") ?? string.Empty;
                var sourceGroup = binding.Value<string>("source_group") ?? binding.Value<string>("sourceGroup") ?? string.Empty;
                var sourceKey = binding.Value<string>("source_key") ?? binding.Value<string>("sourceKey") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(nodeName) && string.IsNullOrWhiteSpace(nodePath)) continue;
                result.Add(new DeviceInspectionPartDto
                {
                    Id = binding.Value<string>("id") ?? $"part_{result.Count + 1}",
                    Name = binding.Value<string>("name") ?? nodeName,
                    NodeName = nodeName,
                    NodePath = nodePath,
                    Description = binding.Value<string>("description") ?? string.Empty,
                    PointKeys = string.IsNullOrWhiteSpace(sourceKey)
                        ? new List<string>()
                        : new List<string> { $"{sourceGroup}.{sourceKey}" }
                });
            }
            return result;
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
