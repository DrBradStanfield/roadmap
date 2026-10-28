import SwiftUI
import VisionKit

/// iOS's document camera, for a paper report (US-52 AC10): it finds the page's
/// edges, flattens it and takes several pages in one go. Each page comes back
/// as an image; a cancel comes back as none. Not on the simulator, which has no camera.
struct DocumentScanner: UIViewControllerRepresentable {
    let done: ([UIImage]) -> Void

    static var isAvailable: Bool { VNDocumentCameraViewController.isSupported }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let camera = VNDocumentCameraViewController()
        camera.delegate = context.coordinator
        return camera
    }

    func updateUIViewController(_ camera: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let done: ([UIImage]) -> Void
        init(done: @escaping ([UIImage]) -> Void) { self.done = done }

        func documentCameraViewController(_ camera: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            done((0..<scan.pageCount).map(scan.imageOfPage(at:)))
        }

        func documentCameraViewControllerDidCancel(_ camera: VNDocumentCameraViewController) {
            done([])
        }

        func documentCameraViewController(_ camera: VNDocumentCameraViewController, didFailWithError error: Error) {
            done([])
        }
    }
}
