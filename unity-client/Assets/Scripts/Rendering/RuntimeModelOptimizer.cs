using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.Rendering;

namespace HeatTreatment.DigitalTwin.Rendering
{
    public sealed class RuntimeModelOptimizationReport
    {
        public int SourceRenderers { get; internal set; }
        public int CombinedRenderers { get; internal set; }
        public int AnimatedRenderers { get; internal set; }
        public int SourceTriangles { get; internal set; }
        public bool Applied { get; internal set; }

        public override string ToString()
        {
            return $"source={SourceRenderers}, combined={CombinedRenderers}, animated={AnimatedRenderers}, triangles={SourceTriangles}";
        }
    }

    public static class RuntimeModelOptimizer
    {
        public static RuntimeModelOptimizationReport Optimize(
            GameObject root,
            IEnumerable<string> animatedNodeNames,
            ModelOptimizationOptions options)
        {
            var report = new RuntimeModelOptimizationReport();
            RuntimeMaterialProcessor.Prepare(root, options);
            if (!options.Enabled || !options.MergeStatic) return report;

            var protectedTransforms = CollectProtectedTransforms(root.transform, animatedNodeNames);
            var candidates = new List<(MeshRenderer renderer, MeshFilter filter)>();
            foreach (var renderer in root.GetComponentsInChildren<MeshRenderer>(true))
            {
                var filter = renderer.GetComponent<MeshFilter>();
                if (filter?.sharedMesh == null) continue;
                report.SourceRenderers += 1;
                report.SourceTriangles += CountTriangles(filter.sharedMesh);
                if (protectedTransforms.Contains(renderer.transform))
                {
                    report.AnimatedRenderers += 1;
                    continue;
                }
                candidates.Add((renderer, filter));
            }

            if (candidates.Count < 2) return report;

            var groups = new Dictionary<Material, List<CombineInstance>>();
            foreach (var candidate in candidates)
            {
                var mesh = candidate.filter.sharedMesh;
                var materials = candidate.renderer.sharedMaterials;
                var subMeshCount = Mathf.Min(mesh.subMeshCount, materials.Length);
                for (var subMesh = 0; subMesh < subMeshCount; subMesh += 1)
                {
                    var material = materials[subMesh];
                    if (material == null) continue;
                    if (!groups.TryGetValue(material, out var entries))
                    {
                        entries = new List<CombineInstance>();
                        groups.Add(material, entries);
                    }
                    entries.Add(new CombineInstance
                    {
                        mesh = mesh,
                        subMeshIndex = subMesh,
                        transform = root.transform.worldToLocalMatrix * candidate.filter.transform.localToWorldMatrix
                    });
                }
            }

            if (groups.Count == 0) return report;
            var generatedRoot = new GameObject("__OptimizedStatic");
            generatedRoot.transform.SetParent(root.transform, false);
            var generatedObjects = new List<GameObject>();
            try
            {
                var index = 0;
                foreach (var pair in groups)
                {
                    var mesh = new Mesh
                    {
                        name = $"optimized_{index:00}_{Sanitize(pair.Key.name)}",
                        indexFormat = IndexFormat.UInt32
                    };
                    mesh.CombineMeshes(pair.Value.ToArray(), true, true, false);
                    mesh.RecalculateBounds();

                    var child = new GameObject(mesh.name);
                    child.transform.SetParent(generatedRoot.transform, false);
                    child.AddComponent<MeshFilter>().sharedMesh = mesh;
                    var renderer = child.AddComponent<MeshRenderer>();
                    renderer.sharedMaterial = pair.Key;
                    renderer.shadowCastingMode = ShadowCastingMode.On;
                    renderer.receiveShadows = true;
                    renderer.lightProbeUsage = LightProbeUsage.BlendProbes;
                    renderer.reflectionProbeUsage = ReflectionProbeUsage.BlendProbes;
                    generatedObjects.Add(child);
                    index += 1;
                }

                foreach (var candidate in candidates) candidate.renderer.enabled = false;
                report.CombinedRenderers = generatedObjects.Count;
                report.Applied = true;
                return report;
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[RuntimeModelOptimizer] Safe fallback for {root.name}: {exception.Message}");
                foreach (var candidate in candidates) candidate.renderer.enabled = true;
                UnityEngine.Object.Destroy(generatedRoot);
                report.CombinedRenderers = 0;
                report.Applied = false;
                return report;
            }
        }

        private static HashSet<Transform> CollectProtectedTransforms(Transform root, IEnumerable<string> names)
        {
            var requested = new HashSet<string>(names?.Where(name => !string.IsNullOrWhiteSpace(name)) ?? Array.Empty<string>());
            var protectedTransforms = new HashSet<Transform>();
            if (requested.Count == 0) return protectedTransforms;
            foreach (var transform in root.GetComponentsInChildren<Transform>(true))
            {
                if (!requested.Contains(transform.name)) continue;
                foreach (var child in transform.GetComponentsInChildren<Transform>(true)) protectedTransforms.Add(child);
            }
            return protectedTransforms;
        }

        private static int CountTriangles(Mesh mesh)
        {
            var count = 0;
            for (var index = 0; index < mesh.subMeshCount; index += 1)
            {
                count += (int)mesh.GetIndexCount(index) / 3;
            }
            return count;
        }

        private static string Sanitize(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "material";
            return new string(value.Select(character => char.IsLetterOrDigit(character) ? character : '_').ToArray());
        }
    }
}
