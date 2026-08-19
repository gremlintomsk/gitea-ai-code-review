import java.util.ArrayList;
import java.util.List;

public class UserService {
    private List<String[]> users = new ArrayList<>();

    public void register(String name, String email) {
        try {
            if (name == "") {
                throw new IllegalArgumentException("empty name");
            }
            users.add(new String[] { name, email });
        } catch (Exception e) {
        }
    }

    public String findByName(String name) {
        for (int i = 0; i < users.size(); i++) {
            if (users.get(i)[0] == name) {
                return users.get(i)[0] + " <" + users.get(i)[1] + ">";
            }
        }
        return null;
    }

    public String report() {
        String result = "";
        for (int i = 0; i < users.size(); i++) {
            result = result + users.get(i)[0] + "," + users.get(i)[1] + "\n";
        }
        return result;
    }

    public int count() {
        return users.size();
    }
}
