using UnityEngine;

namespace HeatTreatment.DigitalTwin.Rendering
{
    [RequireComponent(typeof(Camera))]
    public sealed class OrbitCameraController : MonoBehaviour
    {
        [SerializeField] private float rotateSpeed = 0.22f;
        [SerializeField] private float panSpeed = 0.0022f;
        [SerializeField] private float zoomSpeed = 0.11f;
        [SerializeField] private float keyboardPanSpeed = 14f;

        private Vector3 _target;
        private Vector3 _desiredTarget;
        private float _yaw = -35f;
        private float _desiredYaw = -35f;
        private float _pitch = 24f;
        private float _desiredPitch = 24f;
        private float _distance = 48f;
        private float _desiredDistance = 48f;
        private Bounds _lastBounds = new Bounds(Vector3.zero, new Vector3(40f, 8f, 30f));
        private float _transitionSeconds = 0.22f;
        private Vector3 _targetOffset = Vector3.zero;

        public Vector3 Target => _target;
        public bool InteractionEnabled { get; set; } = true;
        public bool PointerInputBlocked { get; set; }

        public void SetTransitionDuration(float seconds)
        {
            _transitionSeconds = Mathf.Clamp(seconds, 0f, 10f);
        }

        public void SetTargetOffset(Vector3 offset)
        {
            _targetOffset = offset;
        }

        public void FrameBounds(Bounds bounds, bool immediate = false)
        {
            FocusBounds(bounds, -35f, 24f, 1.08f, immediate);
        }

        public void FocusBounds(
            Bounds bounds,
            float yaw,
            float pitch,
            float padding = 1.08f,
            bool immediate = false)
        {
            _lastBounds = bounds;
            _desiredTarget = bounds.center + Vector3.up * Mathf.Max(0.5f, bounds.extents.y * 0.08f) + _targetOffset;
            _desiredYaw = yaw;
            _desiredPitch = Mathf.Clamp(pitch, 6f, 82f);
            var camera = GetComponent<Camera>();
            var radius = Mathf.Max(3f, bounds.extents.magnitude);
            var halfFov = Mathf.Max(12f, camera.fieldOfView * 0.5f) * Mathf.Deg2Rad;
            _desiredDistance = Mathf.Clamp(radius / Mathf.Tan(halfFov) * Mathf.Max(0.65f, padding), 6f, 220f);
            if (!immediate) return;
            _target = _desiredTarget;
            _yaw = _desiredYaw;
            _pitch = _desiredPitch;
            _distance = _desiredDistance;
            ApplyTransform();
        }

        public void NudgeYaw(float degrees)
        {
            _desiredYaw += degrees;
        }

        public void ZoomBy(float multiplier)
        {
            _desiredDistance = Mathf.Clamp(_desiredDistance * Mathf.Max(0.1f, multiplier), 2.5f, 260f);
        }

        private void Awake()
        {
            _target = _desiredTarget = new Vector3(0f, 2f, 0f);
            ApplyTransform();
        }

        private void Update()
        {
            var allowPointer = InteractionEnabled && !PointerInputBlocked;
            if (allowPointer && Input.GetMouseButton(0))
            {
                _desiredYaw += Input.GetAxisRaw("Mouse X") * rotateSpeed * 14f;
                _desiredPitch -= Input.GetAxisRaw("Mouse Y") * rotateSpeed * 14f;
                _desiredPitch = Mathf.Clamp(_desiredPitch, 6f, 82f);
            }

            if (allowPointer && (Input.GetMouseButton(2) || Input.GetMouseButton(1)))
            {
                var rotation = Quaternion.Euler(0f, _yaw, 0f);
                var right = rotation * Vector3.right;
                var forward = rotation * Vector3.forward;
                var amount = Mathf.Max(4f, _distance) * panSpeed;
                _desiredTarget -= right * (Input.GetAxisRaw("Mouse X") * amount);
                _desiredTarget -= forward * (Input.GetAxisRaw("Mouse Y") * amount);
            }

            var wheel = allowPointer ? Input.mouseScrollDelta.y : 0f;
            if (Mathf.Abs(wheel) > 0.001f)
            {
                _desiredDistance *= Mathf.Exp(-wheel * zoomSpeed);
                _desiredDistance = Mathf.Clamp(_desiredDistance, 2.5f, 260f);
            }

            var keyboard = InteractionEnabled
                ? new Vector2(Input.GetAxisRaw("Horizontal"), Input.GetAxisRaw("Vertical"))
                : Vector2.zero;
            if (keyboard.sqrMagnitude > 0.001f)
            {
                var rotation = Quaternion.Euler(0f, _yaw, 0f);
                var move = rotation * new Vector3(keyboard.x, 0f, keyboard.y);
                _desiredTarget += move * (keyboardPanSpeed * Time.unscaledDeltaTime);
            }
            if (InteractionEnabled && Input.GetKey(KeyCode.Q)) _desiredTarget += Vector3.down * (keyboardPanSpeed * Time.unscaledDeltaTime);
            if (InteractionEnabled && Input.GetKey(KeyCode.E)) _desiredTarget += Vector3.up * (keyboardPanSpeed * Time.unscaledDeltaTime);
            if (Input.GetKeyDown(KeyCode.Home)) FrameBounds(_lastBounds);
        }

        private void LateUpdate()
        {
            var response = _transitionSeconds <= 0.001f ? 1000f : 4.6f / _transitionSeconds;
            var blend = 1f - Mathf.Exp(-response * Time.unscaledDeltaTime);
            _target = Vector3.Lerp(_target, _desiredTarget, blend);
            _yaw = Mathf.LerpAngle(_yaw, _desiredYaw, blend);
            _pitch = Mathf.Lerp(_pitch, _desiredPitch, blend);
            _distance = Mathf.Lerp(_distance, _desiredDistance, blend);
            ApplyTransform();
        }

        private void ApplyTransform()
        {
            var rotation = Quaternion.Euler(_pitch, _yaw, 0f);
            transform.SetPositionAndRotation(_target - rotation * Vector3.forward * _distance, rotation);
        }
    }
}
