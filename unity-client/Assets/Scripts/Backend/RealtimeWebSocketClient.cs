using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Backend
{
    public sealed class RealtimeWebSocketClient : MonoBehaviour
    {
        private readonly ConcurrentQueue<JObject> _messages = new ConcurrentQueue<JObject>();
        private CancellationTokenSource _lifetime;
        private ClientWebSocket _socket;
        private Uri _endpoint;
        private float _reconnectSeconds = 2f;

        public bool IsConnected => _socket?.State == WebSocketState.Open;
        public event Action<JObject> MessageReceived;
        public event Action<string> ConnectionStateChanged;

        public void StartClient(string endpoint, float reconnectSeconds)
        {
            StopClient();
            _endpoint = new Uri(endpoint);
            _reconnectSeconds = Mathf.Max(0.5f, reconnectSeconds);
            _lifetime = new CancellationTokenSource();
            _ = RunLoopAsync(_lifetime.Token);
        }

        public void StopClient()
        {
            _lifetime?.Cancel();
            _lifetime?.Dispose();
            _lifetime = null;
            _socket?.Dispose();
            _socket = null;
        }

        private async Task RunLoopAsync(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    _socket = new ClientWebSocket();
                    _socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
                    QueueState("connecting");
                    await _socket.ConnectAsync(_endpoint, cancellationToken);
                    QueueState("connected");
                    await ReceiveLoopAsync(_socket, cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception exception)
                {
                    QueueState($"error:{exception.Message}");
                }
                finally
                {
                    _socket?.Dispose();
                    _socket = null;
                }

                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(_reconnectSeconds), cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
            QueueState("stopped");
        }

        private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
        {
            var buffer = new byte[64 * 1024];
            using var stream = new MemoryStream();
            while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (result.MessageType != WebSocketMessageType.Text) continue;
                stream.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage) continue;

                var json = Encoding.UTF8.GetString(stream.GetBuffer(), 0, (int)stream.Length);
                stream.SetLength(0);
                try { _messages.Enqueue(JObject.Parse(json)); }
                catch (Exception exception) { Debug.LogWarning($"[RealtimeWebSocket] Invalid frame: {exception.Message}"); }
            }
        }

        private void QueueState(string state)
        {
            _messages.Enqueue(new JObject
            {
                ["type"] = "__connection_state",
                ["state"] = state
            });
        }

        private void Update()
        {
            var processed = 0;
            while (processed < 20 && _messages.TryDequeue(out var message))
            {
                processed += 1;
                if (message.Value<string>("type") == "__connection_state")
                {
                    ConnectionStateChanged?.Invoke(message.Value<string>("state"));
                }
                else
                {
                    MessageReceived?.Invoke(message);
                }
            }
        }

        private void OnDestroy()
        {
            StopClient();
        }
    }
}
