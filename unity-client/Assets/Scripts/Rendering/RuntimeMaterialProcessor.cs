using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Rendering
{
    public sealed class ModelOptimizationOptions
    {
        public bool Enabled { get; private set; } = true;
        public bool MergeStatic { get; private set; } = true;
        public bool MaterialEnhancement { get; private set; } = true;
        public bool ContactShadow { get; private set; } = true;
        public float EnvironmentIntensity { get; private set; } = 0.85f;

        public static ModelOptimizationOptions FromMetadata(JObject metadata)
        {
            var options = new ModelOptimizationOptions();
            var source = metadata?["optimization"] as JObject;
            if (source == null)
            {
                if (metadata?.Value<bool?>("batchable") == false) options.Enabled = false;
                return options;
            }

            options.Enabled = !string.Equals(source.Value<string>("mode"), "off", StringComparison.OrdinalIgnoreCase);
            options.MergeStatic = source.Value<bool?>("mergeStatic")
                ?? source.Value<bool?>("merge_static")
                ?? true;
            options.MaterialEnhancement = !string.Equals(
                source.Value<string>("materialEnhancement") ?? source.Value<string>("material_enhancement"),
                "original",
                StringComparison.OrdinalIgnoreCase
            );
            options.ContactShadow = source.Value<bool?>("contactShadow")
                ?? source.Value<bool?>("contact_shadow")
                ?? true;
            options.EnvironmentIntensity = Mathf.Clamp(
                source.Value<float?>("environmentIntensity")
                ?? source.Value<float?>("environment_intensity")
                ?? 0.85f,
                0f,
                2f
            );
            return options;
        }
    }

    public static class RuntimeMaterialProcessor
    {
        private static readonly string[] MetalTerms = { "steel", "metal", "iron", "stainless", "aluminium", "aluminum", "钢", "金属", "不锈钢" };
        private static readonly string[] BrassTerms = { "brass", "copper", "bronze", "黄铜", "铜" };
        private static readonly string[] RubberTerms = { "rubber", "hose", "gasket", "橡胶", "胶管", "密封" };
        private static readonly string[] PaintTerms = { "paint", "panel", "cabinet", "cover", "body", "漆", "面板", "外壳", "柜" };

        public static void Prepare(GameObject root, ModelOptimizationOptions options)
        {
            var seen = new HashSet<Material>();
            foreach (var renderer in root.GetComponentsInChildren<Renderer>(true))
            {
                foreach (var material in renderer.sharedMaterials)
                {
                    if (material == null || !seen.Add(material)) continue;
                    material.enableInstancing = true;
                    if (!options.MaterialEnhancement || HasAuthoredSurface(material)) continue;
                    ApplyNameHeuristics(material);
                }
            }
        }

        private static bool HasAuthoredSurface(Material material)
        {
            return HasTexture(material, "_BaseMap")
                || HasTexture(material, "_MainTex")
                || HasTexture(material, "_BumpMap")
                || HasTexture(material, "_MetallicGlossMap")
                || HasTexture(material, "_SpecGlossMap");
        }

        private static bool HasTexture(Material material, string property)
        {
            return material.HasProperty(property) && material.GetTexture(property) != null;
        }

        private static bool ContainsAny(string value, IEnumerable<string> terms)
        {
            value = (value ?? string.Empty).ToLowerInvariant();
            foreach (var term in terms)
            {
                if (value.Contains(term)) return true;
            }
            return false;
        }

        private static void ApplyNameHeuristics(Material material)
        {
            var name = material.name;
            if (ContainsAny(name, MetalTerms))
            {
                SetFloat(material, "_Metallic", Mathf.Max(GetFloat(material, "_Metallic", 0f), 0.72f));
                SetSmoothness(material, 0.62f);
            }
            else if (ContainsAny(name, BrassTerms))
            {
                SetFloat(material, "_Metallic", Mathf.Max(GetFloat(material, "_Metallic", 0f), 0.68f));
                SetSmoothness(material, 0.58f);
            }
            else if (ContainsAny(name, RubberTerms))
            {
                SetFloat(material, "_Metallic", 0f);
                SetSmoothness(material, 0.18f);
            }
            else if (ContainsAny(name, PaintTerms))
            {
                SetFloat(material, "_Metallic", Mathf.Min(GetFloat(material, "_Metallic", 0f), 0.08f));
                SetSmoothness(material, 0.5f);
            }
        }

        private static float GetFloat(Material material, string property, float fallback)
        {
            return material.HasProperty(property) ? material.GetFloat(property) : fallback;
        }

        private static void SetFloat(Material material, string property, float value)
        {
            if (material.HasProperty(property)) material.SetFloat(property, value);
        }

        private static void SetSmoothness(Material material, float value)
        {
            SetFloat(material, "_Smoothness", value);
            SetFloat(material, "_Glossiness", value);
        }
    }
}
