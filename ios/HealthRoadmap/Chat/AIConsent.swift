import SwiftUI

/// The user's agreement to send data to Anthropic through Brad's server (App Review
/// 5.1.2(i), US-52 AC6/AC7). Kept on the phone with a version: changed wording asks again.
enum AIConsent: String {
    case chat = "consent.chat.v1"
    case labUpload = "consent.labUpload.v1"

    var given: Bool { UserDefaults.standard.bool(forKey: rawValue) }
    func give() { UserDefaults.standard.set(true, forKey: rawValue) }
    /// "Stop sharing": nothing is sent again until the user agrees again.
    func withdraw() { UserDefaults.standard.removeObject(forKey: rawValue) }
}

/// The consent screen shown before the first message or upload. Nothing is sent
/// until the user taps Agree.
struct AIConsentView: View {
    let consent: AIConsent
    let onAgree: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Image(systemName: consent == .chat ? "bubble.left.and.text.bubble.right" : "doc.text.magnifyingglass")
                    .font(.largeTitle)
                    .foregroundStyle(.tint)
                Text(consent == .chat ? "Before you chat" : "Before you upload")
                    .font(.title2.bold())
                Text(whatIsSent)
                Text("They go through Dr Brad's server to **Anthropic**, the company that makes the Claude AI, which writes the answer. Dr Brad's server keeps none of it.")
                Text("Anthropic handles it under its terms for business customers: it does not train its AI on it, and it may keep it for a limited time for safety checks.")
                Text(keptWhere)
                Text("You can stop sharing at any time from this screen's menu.")
                    .foregroundStyle(.secondary)
                Button(action: agree) {
                    Text("Agree and continue").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            .padding()
        }
    }

    private var whatIsSent: String {
        switch consent {
        case .chat: "When you ask a question, the app sends your question, the earlier messages of this conversation, and a summary of your health record: your profile, your latest values and their history, your medications and your screenings."
        case .labUpload: "When you upload a lab report, the app sends the report's text, or a picture of each page that has no text, to read the values on it."
        }
    }

    private var keptWhere: String {
        switch consent {
        case .chat: "Your conversations are saved on this iPhone only."
        case .labUpload: "The values you confirm are saved on this iPhone, in your record. The report itself is not kept."
        }
    }

    private func agree() {
        consent.give()
        onAgree()
    }
}
