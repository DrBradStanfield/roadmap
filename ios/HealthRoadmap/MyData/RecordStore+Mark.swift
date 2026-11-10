import Foundation

/// Which record is on screen, as the chat (US-67) and Apple Health (US-72 AC10) see it.
extension RecordStore {
    /// The record something was read or made on: a chat question or banner (US-67 AC5), an
    /// Apple Health batch (US-72 AC10). The cloud erase it showed, its eraseEpoch and this
    /// phone's erase count. An erase, here or by sync, moves one of them, and what was made
    /// before it writes nothing (US-16 AC2a).
    struct Mark: Equatable, Sendable {
        let erase: String?
        let epoch: Int?
        let erasures: Int

        /// Whether `now` is the same record, never erased since. Connecting or disconnecting a
        /// cloud is not an erase: the cloud erase is compared only while both sides have one.
        func holds(at now: Mark) -> Bool {
            epoch == now.epoch && erasures == now.erasures && (erase == nil || now.erase == nil || erase == now.erase)
        }
    }

    var mark: Mark { Mark(erase: cloudErase, epoch: myData?.eraseEpoch, erasures: erasures) }

    /// Which record is shown, for Apple Health's erase gate (US-72 AC10): "phone", the cloud's
    /// name once its record is open, nil while a connected cloud's record is not open yet.
    var recordSource: String? { cloudErase != nil ? cloudName : marksPending == nil ? "phone" : nil }
}
