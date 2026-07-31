using System;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Rendering
{
    /// <summary>
    /// Material assets under Resources keep runtime-created URP shaders from being stripped
    /// out of Windows player builds. Every caller receives its own material instance.
    /// </summary>
    public static class RuntimeShaderLibrary
    {
        private const string LitResource = "RuntimeMaterials/FactoryLit";
        private const string UnlitResource = "RuntimeMaterials/FactoryUnlit";
        private const string SkyResource = "RuntimeMaterials/FactorySky";

        public static Material CreateLitMaterial(string name)
        {
            return CreateFromResource(LitResource, "Universal Render Pipeline/Lit", name);
        }

        public static Material CreateUnlitMaterial(string name)
        {
            return CreateFromResource(UnlitResource, "Universal Render Pipeline/Unlit", name);
        }

        public static Material CreateSkyboxMaterial(string name)
        {
            return CreateFromResource(SkyResource, "Skybox/Procedural", name);
        }

        private static Material CreateFromResource(string resourcePath, string shaderName, string name)
        {
            var template = Resources.Load<Material>(resourcePath);
            if (template != null)
            {
                return new Material(template) { name = name, enableInstancing = true };
            }

            var shader = Shader.Find(shaderName);
            if (shader == null)
            {
                throw new InvalidOperationException(
                    $"Required runtime shader '{shaderName}' was stripped from the player build."
                );
            }
            return new Material(shader) { name = name, enableInstancing = true };
        }
    }
}
