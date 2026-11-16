import SwiftUI
import CharacterUI

// Compatibility within the host module: rendering and geometry live with the
// shared management surfaces, so character pages cannot drift from pet actions.
typealias WorkspaceControlStyle = ManagementControlStyle
typealias WorkspaceActionButtonStyle = ManagementActionButtonStyle
