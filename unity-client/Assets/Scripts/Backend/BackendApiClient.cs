using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;

namespace HeatTreatment.DigitalTwin.Backend
{
    public sealed class BackendApiClient
    {
        private static readonly HttpClient LoopbackClient = new HttpClient(new HttpClientHandler
        {
            UseProxy = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        })
        {
            Timeout = TimeSpan.FromSeconds(30)
        };

        private readonly string _baseUrl;

        public BackendApiClient(string baseUrl)
        {
            _baseUrl = (baseUrl ?? string.Empty).TrimEnd('/');
        }

        public async Task<FactoryConfigDto> GetFactoryConfigAsync(CancellationToken cancellationToken)
        {
            var url = $"{_baseUrl}/api/config";
            using var response = await LoopbackClient.GetAsync(url, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException(
                    $"Configuration request failed: {(int)response.StatusCode} {response.ReasonPhrase}"
                );
            }
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<FactoryConfigDto>(json)
                ?? throw new InvalidOperationException("Backend returned an empty configuration document.");
        }
    }
}
