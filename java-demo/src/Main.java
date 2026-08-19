public class Main {
    public static void main(String[] args) {
        UserService service = new UserService();
        service.register("alice", "alice@example.com");
        service.register("bob", "bob@example.com");
        System.out.println(service.findByName("alice"));
        System.out.println("total users: " + service.count());
    }
}
