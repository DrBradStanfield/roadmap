/// The app's education lines (App Review 1.4.1), each in one place so every screen that shows
/// one says the same thing. `text`: the welcome screen and Chat's empty state (US-25 AC10b).
enum EducationNote {
    static let text = "For education only, not medical advice. Talk to your doctor before you change anything about your health or medicines."
    /// Under My health's title, above the pills (US-73 AC13). Provisional: Brad approves the exact words.
    static let myHealth = "For education, not medical advice. Always talk to your doctor."
    /// The chat consent screen's first paragraph (US-52 AC6h). Provisional: Brad approves the exact words.
    static let chatConsent = "This app is educational and is not medical advice. Always discuss your health with your doctor."
}
